'use strict';
/* Job lifecycle orchestration.
 *
 *   upload → converting → ready → queued → printing → printed | failed
 *
 * One job prints at a time (printers are serial devices). A transient failure
 * (the printer is asleep, just woke up, or dropped off Wi-Fi) puts the job in
 * "waiting" with a backoff: it keeps trying until it prints or until the retry
 * window closes, so a job sent from across the country still comes out without
 * anyone standing next to the printer. Every transition is broadcast on the
 * event bus, which is what the live queue in the UI is built on. */

const fsp = require('fs').promises;
const fs = require('fs');
const crypto = require('crypto');
const storage = require('../storage');
const config = require('../config');
const log = require('../logger').make('queue');
const converter = require('./converter');
const rasterizer = require('./rasterizer');
const registry = require('./backends/registry');

const EAGER_PREVIEW_PAGES = 6;   // rendered up front for an instant preview
const RETRY_BASE_MS = 5000;      // first backoff between attempts
const RETRY_MAX_MS = 120000;     // backoff ceiling
const ACTIVE_STATUSES = ['uploading', 'converting', 'queued', 'waiting', 'printing'];

// Configuration problems do not fix themselves; retrying only wastes time.
const PERMANENT = [
  /no windows print queue selected/i,
  /no network printer configured/i,
  /no cups queue selected/i,
  /no silent print engine/i,
  /print file is missing/i,
  /nothing to print/i,
  /not a valid pdf/i,
];

const pageLocks = new Map(); // jobId → Promise, prevents duplicate renders
const retryTimers = new Map(); // jobId → Timeout, so a cancel can stop the backoff

/* Libraries in this space throw plain strings; never let that become
 * "failed: undefined" in the log or an empty error in the UI. */
function errorText(error) {
  if (!error) return 'Printing failed';
  if (typeof error === 'string') return error;
  return String(error.message || error.error || error) || 'Printing failed';
}

function isRetryable(error) {
  const text = errorText(error);
  return text.length > 0 && !PERMANENT.some(re => re.test(text));
}

function retryWindowMs() {
  const minutes = Number(config.get('retryWindowMinutes'));
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60000 : 0;
}

function backoffMs(attempts) {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, Math.max(0, (attempts || 1) - 1)));
}

function humanDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

function clearRetry(jobId) {
  const timer = retryTimers.get(jobId);
  if (timer) { clearTimeout(timer); retryTimers.delete(jobId); }
}

function scheduleRetry(jobId, delayMs) {
  clearRetry(jobId);
  const timer = setTimeout(() => {
    retryTimers.delete(jobId);
    pump().catch(() => {});
  }, delayMs);
  if (timer.unref) timer.unref();
  retryTimers.set(jobId, timer);
}

function newId() {
  return `job_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

function defaultOptions(overrides = {}) {
  return {
    copies: parseInt(overrides.copies, 10) || config.get('copies'),
    duplex: overrides.duplex === undefined ? config.get('duplex') : Boolean(overrides.duplex),
    paper: overrides.paper && config.paper(overrides.paper) ? overrides.paper : config.get('paper'),
    scale: overrides.scale === 'actual' ? 'actual' : config.get('scale'),
    range: String(overrides.range || '').trim().slice(0, 120),
  };
}

/* ------------------------------------------------------------------ */
/* Intake                                                              */
/* ------------------------------------------------------------------ */

async function create({ buffer, originalName, mime, batchId = null, options = {}, system = false, owner = null }) {
  const { kind, ext } = converter.classify(originalName, mime);
  if (kind === 'unknown') {
    throw new Error(`Unsupported file type "${ext || mime}" — try PDF, a photo, or a text file`);
  }

  const job = {
    id: newId(),
    name: String(originalName || 'document').slice(0, 180),
    ext,
    mime: mime || '',
    size: buffer.length,
    kind,
    batchId,
    system,
    owner: owner || null,   // guest device id; null = created by the server/admin
    status: 'uploading',
    phase: 'Received',
    progress: 4,
    message: '',
    error: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    printedAt: null,
    pageCount: null,
    renderedPages: 0,
    options: defaultOptions(options),
    backend: null,
    printerJobId: null,
    attempts: 0,
    hasPdf: false,
    hasOriginal: false,
  };

  storage.put(job);
  await fsp.writeFile(storage.originalPath(job), buffer);
  storage.patch(job.id, { hasOriginal: true }, { silent: true });

  setImmediate(() => {
    processConversion(job.id).catch(e => {
      log.error(`conversion crashed for ${job.id}: ${e.message}`);
      storage.patch(job.id, { status: 'failed', error: e.message, phase: 'Failed', progress: 100 });
    });
  });

  return storage.summary(storage.get(job.id));
}

/** Convenience for app-generated documents (test page, QR card). */
async function createFromPdf({ pdfBytes, name, options = {}, system = true }) {
  return create({ buffer: Buffer.from(pdfBytes), originalName: name, mime: 'application/pdf', options, system });
}

/* ------------------------------------------------------------------ */
/* Conversion + preview rendering                                      */
/* ------------------------------------------------------------------ */

async function processConversion(jobId) {
  const job = storage.get(jobId);
  if (!job) return;

  storage.patch(jobId, { status: 'converting', phase: 'Reading document', progress: 12 });
  const buffer = await fsp.readFile(storage.originalPath(job));

  storage.patch(jobId, { phase: job.kind === 'office' ? 'Converting with LibreOffice' : 'Building print-ready PDF', progress: 30 });
  const { pdfBytes, pageCount } = await converter.toPdf(buffer, job.name, job.mime);
  await fsp.writeFile(storage.pdfPath(job), pdfBytes);
  storage.patch(jobId, { hasPdf: true, pageCount: pageCount || null }, { silent: true });

  storage.patch(jobId, { phase: 'Rendering print preview', progress: 62 });
  let rendered = 0;
  let total = pageCount;
  try {
    const pagesToRender = Array.from(
      { length: Math.min(pageCount || EAGER_PREVIEW_PAGES, EAGER_PREVIEW_PAGES) },
      (_, i) => i + 1
    );
    const { pages, pageCount: actualCount } = await rasterizer.renderPages(pdfBytes, pagesToRender);
    total = actualCount || pageCount;
    for (const [page, png] of pages) {
      await fsp.writeFile(storage.previewPath(job, page), png);
      rendered++;
    }
    if (pages.has(1)) {
      const thumb = await rasterizer.thumbnail(pages.get(1), 260);
      await fsp.writeFile(storage.thumbPath(job), thumb);
    }
  } catch (e) {
    log.warn(`preview rendering failed for ${jobId}: ${e.message}`);
  }

  storage.patch(jobId, {
    status: 'ready',
    phase: 'Ready to print',
    progress: 100,
    pageCount: total || null,
    renderedPages: rendered,
    error: '',
    message: rendered ? '' : 'Preview unavailable — printing still works',
  });
  log.info(`${jobId} ready (${job.name}, ${total || '?'} page(s))`);
}

/** Render (and cache) a single preview page on demand. */
async function ensurePreviewPage(jobId, page) {
  const job = storage.get(jobId);
  if (!job || !job.hasPdf) throw new Error('No printable version for this job');
  const limit = config.get('maxPreviewPages');
  if (page < 1 || page > limit) throw new Error(`Preview limited to the first ${limit} pages`);
  if (job.pageCount && page > job.pageCount) throw new Error('Page out of range');

  const file = storage.previewPath(job, page);
  if (fs.existsSync(file)) return file;

  const lockKey = `${jobId}:${page}`;
  if (!pageLocks.has(lockKey)) {
    const task = (async () => {
      const pdfBytes = await fsp.readFile(storage.pdfPath(job));
      const png = await rasterizer.renderPage(pdfBytes, page);
      await fsp.writeFile(file, png);
      const rendered = Math.max(job.renderedPages || 0, page);
      storage.patch(jobId, { renderedPages: rendered }, { silent: true });
      return file;
    })().finally(() => pageLocks.delete(lockKey));
    pageLocks.set(lockKey, task);
  }
  return pageLocks.get(lockKey);
}

/* ------------------------------------------------------------------ */
/* Printing                                                            */
/* ------------------------------------------------------------------ */

async function print(jobId, overrides = {}) {
  const job = storage.get(jobId);
  if (!job) throw new Error('Job not found');
  if (!job.hasPdf) throw new Error('This job has no print-ready version yet');
  if (ACTIVE_STATUSES.includes(job.status)) {
    throw new Error(`Job is already ${job.status}`);
  }

  clearRetry(jobId);
  storage.patch(jobId, {
    status: 'queued',
    phase: 'Queued',
    progress: 6,
    error: '',
    message: '',
    options: defaultOptions({ ...job.options, ...overrides }),
    attempts: 0,
    firstAttemptAt: null,
    nextAttemptAt: null,
  });
  pump();
  return storage.summary(storage.get(jobId));
}

let pumping = false;

/** Oldest first: newly queued jobs, then waiting jobs whose backoff has elapsed. */
function nextRunnable() {
  const jobs = storage.list({ limit: 500 }).reverse();
  const now = Date.now();
  return jobs.find(j => j.status === 'queued')
    || jobs.find(j => j.status === 'waiting' && (!j.nextAttemptAt || new Date(j.nextAttemptAt).getTime() <= now))
    || null;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const next = nextRunnable();
      if (!next) break;
      // eslint-disable-next-line no-await-in-loop
      await run(next);
    }
  } finally {
    pumping = false;
  }
}

/** Called by the watchdog on its poll: picks up waiting jobs whose backoff is over. */
async function pumpWaiting() {
  if (!storage.list({ limit: 500 }).some(j => j.status === 'waiting')) return 0;
  await pump();
  return storage.list({ limit: 500 }).filter(j => j.status === 'waiting').length;
}

/**
 * The printer just became reachable again — stop making waiting jobs sit out
 * their backoff and try them now. That is what turns "sent from the airport"
 * into paper coming out at home.
 */
function wakeWaiters() {
  const waiting = storage.list({ limit: 500 }).filter(j => j.status === 'waiting');
  if (!waiting.length) return 0;
  for (const job of waiting) {
    clearRetry(job.id);
    storage.patch(job.id, {
      nextAttemptAt: new Date().toISOString(),
      phase: 'Printer is back — retrying now',
    });
  }
  pump().catch(() => {});
  // If a print was already in flight, pump() re-checks the list on its next
  // iteration; this nudge covers the tiny window where it had just finished.
  const nudge = setTimeout(() => pump().catch(() => {}), 30);
  if (nudge.unref) nudge.unref();
  return waiting.length;
}

async function run(job) {
  const filePath = storage.pdfPath(job);
  if (!fs.existsSync(filePath)) {
    storage.patch(job.id, { status: 'failed', phase: 'Failed', progress: 100, error: 'Print file is missing — upload the document again' });
    return;
  }

  storage.patch(job.id, {
    status: 'printing',
    phase: 'Sending to printer',
    progress: 25,
    attempts: (job.attempts || 0) + 1,
    firstAttemptAt: job.firstAttemptAt || new Date().toISOString(),
    nextAttemptAt: null,
  });

  try {
    const result = await registry.print({
      job,
      filePath,
      options: job.options,
      onPhase: (message) => storage.patch(job.id, { phase: message, progress: 55 }),
    });
    clearRetry(job.id);
    storage.patch(job.id, {
      status: 'printed',
      phase: 'Printed',
      progress: 100,
      printedAt: new Date().toISOString(),
      backend: result.backend,
      printerJobId: result.printerJobId || null,
      message: result.message || 'Sent to printer',
      error: '',
      nextAttemptAt: null,
    });
    log.info(`${job.id} printed via ${result.backend}: ${result.message}`);
  } catch (e) {
    const reason = errorText(e);
    const current = storage.get(job.id) || job;
    const windowMs = retryWindowMs();
    const delay = backoffMs(current.attempts);
    const elapsed = Date.now() - new Date(current.firstAttemptAt || current.updatedAt).getTime();
    const withinWindow = windowMs > 0 && elapsed + delay <= windowMs;

    if (withinWindow && isRetryable(e)) {
      const nextAttemptAt = new Date(Date.now() + delay).toISOString();
      storage.patch(job.id, {
        status: 'waiting',
        phase: `Printer not ready — retrying in ${Math.round(delay / 1000)}s`,
        progress: 30,
        error: '',
        message: `${reason} · still trying for ${humanDuration(windowMs - elapsed)}`,
        nextAttemptAt,
      });
      log.warn(`${job.id} attempt ${current.attempts} failed (${reason}) — retrying in ${Math.round(delay / 1000)}s`);
      scheduleRetry(job.id, delay);
      return;
    }

    clearRetry(job.id);
    storage.patch(job.id, {
      status: 'failed',
      phase: 'Failed',
      progress: 100,
      error: reason,
      message: withinWindow ? '' : `${reason} · gave up after ${humanDuration(elapsed)} and ${current.attempts} attempt${current.attempts === 1 ? '' : 's'}`,
      nextAttemptAt: null,
    });
    log.error(`${job.id} failed: ${reason}`);
  }
}

async function cancel(jobId) {
  const job = storage.get(jobId);
  if (!job) throw new Error('Job not found');
  clearRetry(jobId);
  if (job.status === 'waiting') {
    storage.patch(jobId, {
      status: 'canceled',
      phase: 'Canceled',
      progress: 100,
      message: 'Canceled while waiting for the printer',
      nextAttemptAt: null,
    });
    return storage.summary(storage.get(jobId));
  }
  if (job.status === 'printing') {
    const res = await registry.cancel(job).catch(() => ({ ok: false }));
    storage.patch(jobId, {
      status: 'canceled',
      phase: 'Canceled',
      progress: 100,
      message: res.ok ? 'Canceled at the printer' : 'Marked canceled — the printer may still finish this page',
    });
    return storage.summary(storage.get(jobId));
  }
  if (job.status === 'queued') {
    storage.patch(jobId, { status: 'canceled', phase: 'Canceled', progress: 100, message: 'Canceled before printing' });
    return storage.summary(storage.get(jobId));
  }
  throw new Error(`Cannot cancel a job that is ${job.status}`);
}

async function retry(jobId) {
  const job = storage.get(jobId);
  if (!job) throw new Error('Job not found');
  if (ACTIVE_STATUSES.includes(job.status)) throw new Error(`Job is already ${job.status}`);
  if (!job.hasPdf) throw new Error('Nothing to print — re-upload the document');
  clearRetry(jobId);
  storage.patch(jobId, {
    status: 'queued', phase: 'Queued again', progress: 6, error: '', message: '',
    attempts: 0, firstAttemptAt: null, nextAttemptAt: null,
  });
  pump();
  return storage.summary(storage.get(jobId));
}

/**
 * After a restart, anything in flight cannot be resumed safely — except jobs
 * that were waiting for a printer that was off. Those are exactly the jobs a
 * user sent from somewhere else and expects to come out, so they resume.
 */
function reconcile() {
  let touched = 0;
  for (const job of storage.list({ limit: 1000 })) {
    if (job.status === 'waiting') {
      storage.patch(job.id, { nextAttemptAt: new Date().toISOString(), phase: 'Waiting for the printer' });
      continue;
    }
    if (['uploading', 'converting', 'queued', 'printing'].includes(job.status)) {
      storage.patch(job.id, {
        status: 'failed',
        phase: 'Interrupted',
        progress: 100,
        error: 'The server restarted while this job was in progress — press retry',
      });
      touched++;
    }
  }
  if (touched) log.warn(`marked ${touched} interrupted job(s) as failed`);
  return touched;
}

module.exports = {
  create, createFromPdf, print, cancel, retry, reconcile,
  ensurePreviewPage, defaultOptions, pumpWaiting, wakeWaiters,
  EAGER_PREVIEW_PAGES, ACTIVE_STATUSES,
};
