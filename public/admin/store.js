/* Admin state + live feed.
 *
 * Unlike the guest stream, this one carries everything: every job from every
 * device, the full printer snapshot, server logs and settings changes. */

import { api, API_ORIGIN } from './api.js';

const listeners = new Set();

export const store = {
  state: {
    ready: false,
    meta: null,
    settings: null,
    printer: null,
    jobs: new Map(),
    logs: [],
    connection: 'connecting',
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

  /** Which device sent a job — shown in the admin queue. */
  devices() {
    const counts = new Map();
    for (const job of store.jobList()) {
      if (!job.owner) continue;
      counts.set(job.owner, (counts.get(job.owner) || 0) + 1);
    }
    return counts;
  },
};

/* ---------------- bootstrap ---------------- */

export async function bootstrap() {
  try {
    const [meta, settings, printer, jobs, logs] = await Promise.all([
      api.meta(), api.settings(), api.printerStatus(), api.jobs(200), api.logs(120),
    ]);
    store.state.meta = meta;
    store.state.settings = settings;
    store.state.printer = printer;
    store.state.logs = logs.logs || [];
    store.state.jobs.clear();
    for (const job of jobs.jobs) store.upsertJob(job);
    store.state.ready = true;
    store.emit('boot');
  } catch (e) {
    if (e.status !== 401) {
      store.state.connection = 'offline';
      store.emit('error', e);
    }
    throw e;
  }
  connectEvents();
}

export function refreshPrinter() {
  return api.printerStatus(true).then((printer) => {
    store.state.printer = printer;
    store.emit('printer');
    return printer;
  }).catch(() => null);
}

export function applySettings(settings) {
  store.state.settings = settings;
  store.emit('settings');
}

/* ---------------- SSE ---------------- */

let source = null;
let retryDelay = 1000;
let retryTimer = null;

export function connectEvents() {
  if (source) { try { source.close(); } catch { /* noop */ } source = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

  source = new EventSource(`${API_ORIGIN}/api/admin/system/events`, { withCredentials: true });

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
    if (data.printer) store.state.printer = data.printer;
    if (data.settings) store.state.settings = data.settings;
    if (data.logs) store.state.logs = data.logs;
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
    store.state.printer = JSON.parse(event.data);
    store.emit('printer');
  });

  source.addEventListener('log', (event) => {
    const entry = JSON.parse(event.data);
    store.state.logs.push(entry);
    if (store.state.logs.length > 400) store.state.logs.splice(0, store.state.logs.length - 400);
    store.emit('log', entry);
  });

  source.addEventListener('settings', (event) => {
    const data = JSON.parse(event.data);
    store.state.settings = data.settings || data;
    store.emit('settings');
  });

  source.addEventListener('error', () => {
    // A closed stream right after a sign-out is expected, not an outage.
    if (source && source.readyState === EventSource.CLOSED) {
      store.state.connection = 'offline';
      store.emit('connection');
      scheduleReconnect();
    }
  });
}

export function disconnectEvents() {
  if (source) { try { source.close(); } catch { /* noop */ } source = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  store.state.connection = 'offline';
}

function scheduleReconnect() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryDelay = Math.min(retryDelay * 1.8, 20000);
    api.session().then((status) => {
      if (!status.authenticated) return;   // the sign-in screen owns it now
      connectEvents();
    }).catch(() => { /* still offline */ });
  }, retryDelay);
}
