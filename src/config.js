'use strict';
/* Config store: validated settings persisted atomically, with change events
 * so the watchdog/backends can react to edits. */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const PAPERS = {
  a4:     { label: 'A4',     ipp: 'iso_a4_210x297mm',   pt: [595.28, 841.89], mm: [210, 297] },
  letter: { label: 'Letter', ipp: 'na_letter_8.5x11in', pt: [612, 792],       mm: [215.9, 279.4] },
  legal:  { label: 'Legal',  ipp: 'na_legal_8.5x14in',  pt: [612, 1008],      mm: [215.9, 355.6] },
  a5:     { label: 'A5',     ipp: 'iso_a5_148x210mm',   pt: [419.53, 595.28], mm: [148, 210] },
};

const BACKENDS = ['auto', 'spooler', 'ipp', 'cups', 'outbox'];
const SCALES = ['fit', 'actual'];

/** A printer address is either a URL or a bare host/IP — "192.168.1.50" is fine. */
const PRINTER_URL = /^(ipp(s)?|https?):\/\/[^\s]+$/i;
const PRINTER_HOST = /^[a-z0-9][a-z0-9._-]*(:\d+)?(\/[^\s]*)?$/i;

const DEFAULTS = {
  appName: 'PrintBridge',
  backend: 'auto',
  spoolerQueue: '',      // Windows print queue (USB or network driver queue)
  cupsQueue: '',         // macOS/Linux CUPS queue
  printerUrl: '',        // ipp://…/ipp/print for network printers
  paper: 'a4',
  copies: 1,
  duplex: false,
  scale: 'fit',
  keepAliveMinutes: 0,
  retryWindowMinutes: 30, // keep retrying a job while the printer is asleep/offline
  remoteUrl: '',          // public/VPN address this server is reached on from outside
  retentionHours: 48,
  maxUploadMb: 25,
  maxPreviewPages: 40,
  theme: 'system',
  adminProtect: true,    // /admin requires the PIN
  sessionDays: 30,       // how long an admin sign-in lasts
};

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitize(patch) {
  const out = {};
  const p = patch || {};
  if (typeof p.appName === 'string' && p.appName.trim()) out.appName = p.appName.trim().slice(0, 40);
  if (BACKENDS.includes(p.backend)) out.backend = p.backend;
  if (typeof p.spoolerQueue === 'string') out.spoolerQueue = p.spoolerQueue.trim().slice(0, 200);
  if (typeof p.cupsQueue === 'string') out.cupsQueue = p.cupsQueue.trim().slice(0, 200);
  if (typeof p.printerUrl === 'string') {
    const url = p.printerUrl.trim().slice(0, 300);
    if (!url || PRINTER_URL.test(url) || PRINTER_HOST.test(url)) out.printerUrl = url;
    else throw new Error('Printer address must look like ipp://192.168.1.50/ipp/print, or just the printer\'s IP');
  }
  if (p.paper !== undefined) {
    if (!PAPERS[p.paper]) throw new Error(`Unknown paper size "${p.paper}"`);
    out.paper = p.paper;
  }
  if (p.copies !== undefined) out.copies = clampInt(p.copies, 1, 50, DEFAULTS.copies);
  if (p.duplex !== undefined) out.duplex = Boolean(p.duplex);
  if (p.scale !== undefined) {
    if (!SCALES.includes(p.scale)) throw new Error('Scale must be "fit" or "actual"');
    out.scale = p.scale;
  }
  if (p.keepAliveMinutes !== undefined) out.keepAliveMinutes = clampInt(p.keepAliveMinutes, 0, 240, 0);
  if (p.retryWindowMinutes !== undefined) out.retryWindowMinutes = clampInt(p.retryWindowMinutes, 0, 720, DEFAULTS.retryWindowMinutes);
  if (typeof p.remoteUrl === 'string') {
    const url = p.remoteUrl.trim().replace(/\/+$/, '').slice(0, 300);
    if (!url || /^https?:\/\//i.test(url)) out.remoteUrl = url;
    else throw new Error('Remote address must start with http:// or https://');
  }
  if (p.retentionHours !== undefined) out.retentionHours = clampInt(p.retentionHours, 1, 720, DEFAULTS.retentionHours);
  if (p.maxUploadMb !== undefined) out.maxUploadMb = clampInt(p.maxUploadMb, 1, 200, DEFAULTS.maxUploadMb);
  if (p.maxPreviewPages !== undefined) out.maxPreviewPages = clampInt(p.maxPreviewPages, 1, 200, DEFAULTS.maxPreviewPages);
  if (p.theme !== undefined && ['system', 'dark', 'light'].includes(p.theme)) out.theme = p.theme;
  if (p.adminProtect !== undefined) out.adminProtect = Boolean(p.adminProtect);
  if (p.sessionDays !== undefined) out.sessionDays = clampInt(p.sessionDays, 1, 365, DEFAULTS.sessionDays);
  return out;
}

class Config extends EventEmitter {
  constructor() {
    super();
    this.data = { ...DEFAULTS };
    this.file = null;
  }

  init(dataDir) {
    this.file = path.join(dataDir, 'config.json');
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.data = { ...DEFAULTS, ...sanitize(raw) };
    this.write();
    return this;
  }

  all() { return { ...this.data, papers: PAPERS, backends: BACKENDS }; }
  get(key) { return this.data[key]; }
  paper(key) { return PAPERS[key] || PAPERS.a4; }

  patch(patch) {
    const clean = sanitize(patch);
    const before = JSON.stringify(this.data);
    this.data = { ...this.data, ...clean };
    this.write();
    if (JSON.stringify(this.data) !== before) this.emit('change', this.data, clean);
    return this.all();
  }

  write() {
    if (!this.file) return;
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[config] write failed:', e.message);
    }
  }
}

module.exports = new Config();
module.exports.PAPERS = PAPERS;
module.exports.DEFAULTS = DEFAULTS;
