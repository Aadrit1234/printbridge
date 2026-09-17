/* Guest application state + live events.
 *
 * The stream is scoped by device id: this browser receives only its own jobs
 * plus the printer's availability. Logs, other people's jobs, diagnostics and
 * settings-writing never reach a guest client.
 *
 * Views subscribe with store.subscribe(fn) and read store.state. */

import { api, API_ORIGIN } from './api.js';
import { deviceId } from './device.js';

const listeners = new Set();

export const store = {
  state: {
    ready: false,
    meta: null,
    settings: null,
    printer: null,
    jobs: new Map(),
    connection: 'connecting', // connecting | live | offline
    lastEventAt: null,
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  emit(type = 'update', detail = null) {
    for (const fn of [...listeners]) {
      try { fn(type, detail); } catch (e) { console.error('listener failed', e); }
    }
  },

  /* ---------------- selectors ---------------- */

  jobList() {
    return [...store.state.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  },

  activeJobs() {
    return store.jobList().filter(j => ['uploading', 'converting', 'queued', 'printing'].includes(j.status));
  },

  jobsByBatch(batchId) {
    return store.jobList().filter(j => j.batchId === batchId);
  },

  upsertJob(job) {
    if (!job || !job.id) return;
    const previous = store.state.jobs.get(job.id);
    store.state.jobs.set(job.id, { ...previous, ...job });
  },
};

/* The server sends guests a redacted printer summary; views read the same
 * nested shape the admin snapshot uses, so keep one interpretation in place. */
function toPrinterState(summary) {
  if (!summary) return null;
  return {
    state: {
      name: summary.name || null,
      status: summary.status || 'unknown',
      detail: summary.detail || '',
      markers: summary.markers || [],
      queueDepth: null,
    },
    active: { kind: summary.kind || 'unknown', label: summary.label || '', id: summary.kind || '' },
    reason: summary.reason || '',
    at: summary.at,
    slim: true,
  };
}

/* ---------------- bootstrap ---------------- */

export async function bootstrap() {
  try {
    const [meta, settings, printer, jobs] = await Promise.all([
      api.meta(), api.settings(), api.printerStatus(), api.jobs(100),
    ]);
    store.state.meta = meta;
    store.state.settings = settings;
    store.state.printer = toPrinterState(printer.printer);
    for (const job of jobs.jobs) store.upsertJob(job);
    store.state.ready = true;
    store.emit('boot');
  } catch (e) {
    store.state.connection = 'offline';
    store.emit('error', e);
  }
  connectEvents();
}

export function refreshPrinter() {
  return api.printerStatus(true).then((res) => {
    store.state.printer = toPrinterState(res.printer);
    store.emit('printer');
    return store.state.printer;
  }).catch(() => null);
}

/* ---------------- SSE ---------------- */

let source = null;
let retryDelay = 1000;
let retryTimer = null;

function connectEvents() {
  if (source) { try { source.close(); } catch { /* noop */ } source = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

  source = new EventSource(`${API_ORIGIN}/api/v1/system/events?device=${encodeURIComponent(deviceId())}`);

  source.addEventListener('open', () => {
    store.state.connection = 'live';
    retryDelay = 1000;
    store.emit('connection');
  });

  source.addEventListener('hello', (event) => {
    const data = JSON.parse(event.data);
    if (data.jobs) {
      store.state.jobs.clear();
      for (const job of data.jobs) store.upsertJob(job);
    }
    if (data.printer) store.state.printer = toPrinterState(data.printer);
    if (data.settings) store.state.settings = { ...store.state.settings, ...data.settings };
    store.state.connection = 'live';
    store.emit('hello');
  });

  source.addEventListener('job', (event) => {
    const job = JSON.parse(event.data);
    store.state.lastEventAt = Date.now();
    store.upsertJob(job);
    store.emit('job', job);
  });

  source.addEventListener('jobDeleted', (event) => {
    const { id } = JSON.parse(event.data);
    store.state.jobs.delete(id);
    store.emit('jobDeleted', id);
  });

  source.addEventListener('printer', (event) => {
    store.state.printer = toPrinterState(JSON.parse(event.data));
    store.emit('printer');
  });

  source.addEventListener('error', () => {
    if (source && source.readyState === EventSource.CLOSED) {
      store.state.connection = 'offline';
      store.emit('connection');
      scheduleReconnect();
    }
  });
}

function scheduleReconnect() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryDelay = Math.min(retryDelay * 1.8, 20000);
    connectEvents();
    bootstrapDataOnly();
  }, retryDelay);
}

async function bootstrapDataOnly() {
  try {
    const [jobs, printer] = await Promise.all([api.jobs(100), api.printerStatus(true)]);
    store.state.jobs.clear();
    for (const job of jobs.jobs) store.upsertJob(job);
    store.state.printer = toPrinterState(printer.printer);
    store.emit('resync');
  } catch { /* still offline */ }
}

/* Keep the connection honest if the tab was suspended. */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (!source || source.readyState === EventSource.CLOSED)) connectEvents();
});
