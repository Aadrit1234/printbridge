'use strict';
/* Job repository + file layout. Jobs are kept in memory for fast reads and
 * persisted to data/jobs.json with atomic, debounced writes. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const bus = require('./events');
const log = require('./logger').make('storage');

const TERMINAL = new Set(['printed', 'failed', 'canceled']);
const ACTIVE = new Set(['uploading', 'converting', 'ready', 'queued', 'waiting', 'printing']);

class Storage {
  constructor() {
    this.root = null;
    this.dirs = {};
    this.jobs = new Map();
    this.jobsFile = null;
    this._saveTimer = null;
  }

  init(dataDir) {
    this.root = dataDir;
    this.dirs = {
      uploads: path.join(dataDir, 'uploads'),
      pdf: path.join(dataDir, 'pdf'),
      previews: path.join(dataDir, 'previews'),
      thumbs: path.join(dataDir, 'thumbs'),
      outbox: path.join(dataDir, 'outbox'),
      print: path.join(dataDir, 'print'),
    };
    for (const dir of Object.values(this.dirs)) fs.mkdirSync(dir, { recursive: true });
    this.jobsFile = path.join(dataDir, 'jobs.json');
    try {
      const list = JSON.parse(fs.readFileSync(this.jobsFile, 'utf8'));
      for (const job of list) if (job && job.id) this.jobs.set(job.id, job);
      if (this.jobs.size) log.info(`loaded ${this.jobs.size} stored job(s)`);
    } catch { /* first run */ }
    return this;
  }

  /* ---------------- job access ---------------- */

  get(id) { return this.jobs.get(id) || null; }

  /** `owner` scopes the list to one guest device; omit it for the admin view. */
  list({ limit = 100, batchId = null, owner = null } = {}) {
    let out = [...this.jobs.values()];
    if (batchId) out = out.filter(j => j.batchId === batchId);
    if (owner) out = out.filter(j => j.owner === owner);
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out.slice(0, limit);
  }

  put(job) {
    this.jobs.set(job.id, job);
    this._scheduleSave();
    bus.emit('job', summary(job));
    return job;
  }

  /** Patch a job and broadcast the change (unless silent). */
  patch(id, changes, { silent = false } = {}) {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, changes, { updatedAt: new Date().toISOString() });
    this._scheduleSave();
    if (!silent) bus.emit('job', summary(job));
    return job;
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.jobs.delete(id);
    this._scheduleSave();
    bus.emit('jobDeleted', { id });
    return true;
  }

  clearTerminal() {
    const removed = [];
    for (const [id, job] of this.jobs) {
      if (TERMINAL.has(job.status)) { this.jobs.delete(id); removed.push(job); }
    }
    this._scheduleSave();
    for (const job of removed) bus.emit('jobDeleted', { id: job.id });
    return removed;
  }

  isTerminal(job) { return TERMINAL.has(job.status); }
  isActive(job) { return ACTIVE.has(job.status); }

  /* ---------------- files ---------------- */

  originalPath(job) { return path.join(this.dirs.uploads, `${job.id}${job.ext || ''}`); }
  pdfPath(job) { return path.join(this.dirs.pdf, `${job.id}.pdf`); }
  previewPath(job, page) { return path.join(this.dirs.previews, `${job.id}_p${page}.png`); }
  previewPattern(job) { return `${job.id}_p`; }
  thumbPath(job) { return path.join(this.dirs.thumbs, `${job.id}.png`); }

  /** The print copy: the token page merged in front of the job, what actually prints. */
  printCopyPath(job) { return path.join(this.dirs.print, `${job.id}.pdf`); }

  async purgePrintCopy(job) {
    await fsp.unlink(this.printCopyPath(job)).catch(() => {});
    if (job.printCopy) { job.printCopy = null; this._scheduleSave(); }
  }

  async jobFileBytes(job) {
    const file = job.kind === 'pdf' && job.storage.pdf ? this.pdfPath(job) : this.pdfPath(job);
    return fsp.readFile(file);
  }

  /* ---------------- persistence ---------------- */

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save().catch(e => log.warn('save failed: ' + e.message));
    }, 250);
  }

  async save() {
    const tmp = this.jobsFile + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify([...this.jobs.values()], null, 2));
    await fsp.rename(tmp, this.jobsFile);
  }

  /* ---------------- housekeeping ---------------- */

  /** Delete files of expired jobs and cap the archive size. */
  async cleanup({ retentionHours = 48, maxJobs = 200 } = {}) {
    const cutoff = Date.now() - retentionHours * 3600 * 1000;
    let purged = 0;

    const terminalJobs = [...this.jobs.values()]
      .filter(j => TERMINAL.has(j.status))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

    for (let i = 0; i < terminalJobs.length; i++) {
      const job = terminalJobs[i];
      const expired = new Date(job.updatedAt).getTime() < cutoff;
      const overCap = i >= maxJobs;
      if (!expired && !overCap) continue;
      await this.purgeFiles(job);
      this.jobs.delete(job.id);
      purged++;
    }
    await this.sweepPrintCopies([...this.jobs.keys()]);
    if (purged) { this._scheduleSave(); log.info(`cleaned up ${purged} old job(s)`); }
    return purged;
  }

  async purgeFiles(job) {
    const targets = [this.pdfPath(job), this.thumbPath(job), this.printCopyPath(job)];
    for (let p = 1; p <= (job.renderedPages || 0) + 5; p++) targets.push(this.previewPath(job, p));
    for (const ext of ['', job.ext || '.pdf']) targets.push(path.join(this.dirs.uploads, `${job.id}${ext}`));
    await Promise.allSettled(targets.map(f => fsp.unlink(f).catch(() => {})));
  }

  /** Remove print copies left over by jobs that no longer exist. */
  async sweepPrintCopies(jobIds) {
    const keep = new Set(jobIds);
    try {
      for (const entry of await fsp.readdir(this.dirs.print)) {
        const id = entry.replace(/\.pdf$/, '');
        if (!keep.has(id)) await fsp.unlink(path.join(this.dirs.print, entry)).catch(() => {});
      }
    } catch { /* no dir yet */ }
  }

  async usage() {
    const out = { totalBytes: 0, dirs: {} };
    for (const [name, dir] of Object.entries(this.dirs)) {
      let bytes = 0, files = 0;
      try {
        for (const entry of await fsp.readdir(dir)) {
          try { const st = await fsp.stat(path.join(dir, entry)); bytes += st.size; files++; } catch { /* skip */ }
        }
      } catch { /* skip */ }
      out.dirs[name] = { bytes, files };
      out.totalBytes += bytes;
    }
    out.jobs = this.jobs.size;
    return out;
  }
}

/** Compact, serialisable representation used by the API and SSE. */
function summary(job) {
  return {
    id: job.id,
    name: job.name,
    ext: job.ext || '',
    mime: job.mime || '',
    size: job.size || 0,
    kind: job.kind || null,
    status: job.status,
    phase: job.phase || '',
    progress: job.progress == null ? 0 : job.progress,
    message: job.message || '',
    error: job.error || '',
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    printedAt: job.printedAt || null,
    pageCount: job.pageCount || null,
    renderedPages: job.renderedPages || 0,
    options: job.options || null,
    backend: job.backend || null,
    printerJobId: job.printerJobId || null,
    batchId: job.batchId || null,
    owner: job.owner || null,
    attempts: job.attempts || 0,
    nextAttemptAt: job.nextAttemptAt || null,
    target: job.target || null,
    token: job.token || null,
    tickets: Array.isArray(job.tickets) ? job.tickets : [],
    payment: job.payment || null,
    superseded: Boolean(job.superseded),
    combined: Boolean(job.combined),
    system: Boolean(job.system),
    hasPdf: Boolean(job.hasPdf),
    hasOriginal: Boolean(job.hasOriginal),
  };
}

module.exports = new Storage();
module.exports.summary = summary;
module.exports.TERMINAL = TERMINAL;
