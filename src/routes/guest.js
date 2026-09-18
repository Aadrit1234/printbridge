'use strict';
/* Guest API (/api/v1) — what a phone that just scanned the QR code needs.
 *
 * Deliberately narrow:
 *   • it can only ever see jobs created by the same device (X-Device-Id),
 *   • it cannot change print defaults, printer configuration, storage, or read
 *     logs and diagnostics — all of that is the admin API behind the PIN,
 *   • printer status is a redacted summary (no queue names, no internals).
 *
 * Admin access to the whole system lives in src/routes/admin.js.
 */

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const bus = require('../events');
const config = require('../config');
const storage = require('../storage');
const queue = require('../services/queue');
const rasterizer = require('../services/rasterizer');
const registry = require('../services/backends/registry');
const tickets = require('../services/tickets');
const log = require('../logger').make('api:guest');
const { getUploader, decodeName, uploadError, optionsFrom } = require('../upload');

const router = express.Router();

const DEVICE_RE = /^[0-9a-zA-Z_-]{4,64}$/;

/** A device id identifies the browser that uploaded a job. */
function deviceId(req, { required = true } = {}) {
  const raw = req.get('x-device-id') || req.query.device || req.body?.deviceId;
  const value = String(raw || '').trim();
  if (DEVICE_RE.test(value)) return value;
  if (required) return null;
  return '';
}

function deviceGate(req, res, next) {
  const id = deviceId(req);
  if (!id) {
    return res.status(400).json({
      error: 'This browser has no device id yet — reload the page and try again.',
      hint: 'Guest requests must include an X-Device-Id header (or ?device=).',
    });
  }
  req.device = id;
  return next();
}

/** The job, but only if this device created it. */
function ownJob(req, res) {
  const job = storage.get(String(req.params.id || ''));
  if (!job || job.owner !== req.device) {
    res.status(404).json({ error: 'Job not found' });
    return null;
  }
  return job;
}

/** Printer state a guest may see: friendly, no queue names or internals. */
function slimPrinter(snapshot) {
  if (!snapshot) return null;
  const state = snapshot.state || {};
  return {
    ready: state.status === 'ready',
    status: state.status || 'unknown',
    name: state.name || null,
    detail: state.detail || '',
    reason: snapshot.reason || '',
    kind: snapshot.active?.kind || 'unknown',
    label: snapshot.active?.label || '',
    markers: (state.markers || []).map(m => ({ name: m.name, level: m.level })),
    at: snapshot.at || new Date().toISOString(),
  };
}

/* ---------------------------------------------------------------- jobs */

router.post('/jobs', deviceGate, (req, res) => {
  getUploader().array('files', 12)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: uploadError(err) });

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files received' });

    const batchId = String(req.body.batchId || `batch_${Date.now().toString(36)}`);
    const options = optionsFrom(req.body);
    const jobs = [];
    const errors = [];

    for (const file of files) {
      try {
        // eslint-disable-next-line no-await-in-loop
        jobs.push(await queue.create({
          buffer: file.buffer,
          originalName: decodeName(file.originalname),
          mime: file.mimetype,
          batchId,
          options,
          owner: req.device,
        }));
      } catch (e) {
        errors.push({ name: decodeName(file.originalname), error: e.message });
        log.warn(`rejected "${file.originalname}" from ${req.device}: ${e.message}`);
      }
    }
    return res.status(jobs.length ? 201 : 422).json({ jobs, errors, batchId });
  });
});

router.get('/jobs', deviceGate, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const batchId = req.query.batchId ? String(req.query.batchId) : null;
  res.json({ jobs: storage.list({ limit, batchId, owner: req.device }).map(storage.summary) });
});

router.get('/jobs/:id', deviceGate, (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  res.json(storage.summary(job));
});

router.post('/jobs/:id/print', deviceGate, async (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  try {
    res.json(await queue.print(job.id, req.body || {}));
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

/* ------------------------------------------------------------- tickets */

/** Printer choices this device may send a job to (no queue internals). */
router.get('/printers', async (req, res) => {
  try {
    const { printers, default: preferred, reason } = await registry.targets();
    res.json({
      printers: printers.map(p => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        detail: p.detail,
        status: p.status,
        recommended: Boolean(p.recommended || p.id === preferred),
      })),
      default: preferred,
      reason,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Look up the state of one of this device's print commands by its token. */
router.get('/tickets/:token', deviceGate, (req, res) => {
  const wanted = tickets.normalize(req.params.token);
  if (!wanted) return res.status(400).json({ error: 'That does not look like a print code (PB-XXXX-XXXX)' });

  for (const job of storage.list({ limit: 200, owner: req.device })) {
    const ticket = tickets.forJob(job, wanted);
    if (!ticket) continue;
    return res.json({ ticket: { ...ticket, jobId: job.id, jobName: job.name, pageCount: job.pageCount } });
  }
  return res.status(404).json({ error: 'No print with that code belongs to this device' });
});

/** Send a job that already exists again — a fresh print command, a fresh code. */
router.post('/jobs/:id/retry', deviceGate, async (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  try {
    res.json(await queue.retry(job.id));
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

router.post('/jobs/:id/cancel', deviceGate, async (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  try {
    res.json(await queue.cancel(job.id));
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

router.delete('/jobs/:id', deviceGate, async (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  if (['queued', 'waiting', 'printing'].includes(job.status)) {
    return res.status(409).json({ error: 'Cancel the job before deleting it' });
  }
  await storage.purgeFiles(job);
  storage.remove(job.id);
  return res.json({ ok: true });
});

/* --------------------------------------------------------------- files */

router.get('/files/:id/pdf', deviceGate, (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  if (!job.hasPdf) return res.status(409).json({ error: 'Not converted yet' });
  const file = storage.pdfPath(job);
  if (!fs.existsSync(file)) return res.status(410).json({ error: 'File no longer available' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(job.name.replace(/\.[^.]+$/, ''))}.pdf"`);
  return fs.createReadStream(file).pipe(res);
});

router.get('/files/:id/original', deviceGate, (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  const file = storage.originalPath(job);
  if (!fs.existsSync(file)) return res.status(410).json({ error: 'Original no longer kept' });
  return res.download(file, job.name);
});

router.get('/files/:id/preview/:page.png', deviceGate, async (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  const page = parseInt(req.params.page, 10);
  if (!Number.isFinite(page)) return res.status(400).json({ error: 'Bad page number' });
  try {
    const file = await queue.ensurePreviewPage(job.id, page);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.sendFile(file);
  } catch (e) {
    return res.status(404).json({ error: e.message });
  }
});

router.get('/files/:id/thumb.png', deviceGate, async (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  const thumb = storage.thumbPath(job);
  if (fs.existsSync(thumb)) {
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.sendFile(thumb);
  }
  try {
    const page = await queue.ensurePreviewPage(job.id, 1);
    const png = await rasterizer.thumbnail(await fsp.readFile(page), 260);
    await fsp.writeFile(thumb, png);
    res.setHeader('Content-Type', 'image/png');
    return res.send(png);
  } catch {
    return res.status(404).json({ error: 'No thumbnail available' });
  }
});

router.get('/files/:id/meta', deviceGate, (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  return res.json({
    id: job.id,
    pageCount: job.pageCount,
    renderedPages: job.renderedPages,
    maxPreviewPages: config.get('maxPreviewPages'),
    kind: job.kind,
    hasPdf: job.hasPdf,
  });
});

/* ------------------------------------------------------- status + boot */

router.get('/printer/status', async (req, res) => {
  const snapshot = await registry.state().catch(() => null);
  res.json({ printer: slimPrinter(snapshot) });
});

/* The guest side is the whole product for anyone who scans the code: it names
 * the app and nothing about the control room behind it. */
router.get('/system/meta', (req, res) => {
  res.json({
    appName: config.get('appName'),
    version: require('../../package.json').version,
    platform: process.platform,
    host: require('os').hostname(),
    uptime: Math.round(process.uptime()),
    now: new Date().toISOString(),
  });
});

/** Read-only defaults so the guest print sheet starts from the house settings. */
router.get('/system/settings', (req, res) => {
  const all = config.all();
  res.json({
    appName: all.appName,
    paper: all.paper,
    copies: all.copies,
    duplex: all.duplex,
    scale: all.scale,
    maxUploadMb: all.maxUploadMb,
    maxPreviewPages: all.maxPreviewPages,
    papers: all.papers,
  });
});

/* --------------------------------------------------------------- events */

/** Live feed scoped to this device: its own jobs plus printer availability. */
router.get('/system/events', async (req, res) => {
  const device = deviceId(req, { required: false });
  if (!device) return res.status(400).json({ error: 'Missing ?device= parameter' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, payload) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ }
  };

  const snapshot = await registry.state().catch(() => null);
  const targets = await registry.targets().catch(() => ({ printers: [], default: null, reason: '' }));
  send('hello', {
    at: new Date().toISOString(),
    device,
    jobs: storage.list({ limit: 50, owner: device }).map(storage.summary),
    printer: slimPrinter(snapshot),
    printers: targets.printers.map(p => ({
      id: p.id, name: p.name, kind: p.kind, detail: p.detail,
      status: p.status, recommended: Boolean(p.recommended || p.id === targets.default),
    })),
    defaultPrinter: targets.default,
    settings: {
      paper: config.get('paper'),
      copies: config.get('copies'),
      duplex: config.get('duplex'),
      scale: config.get('scale'),
      maxUploadMb: config.get('maxUploadMb'),
      maxPreviewPages: config.get('maxPreviewPages'),
      papers: config.all().papers,
    },
  });

  const onJob = (job) => { if (job.owner === device) send('job', job); };
  const onJobDeleted = ({ id }) => {
    const job = storage.get(id);
    send('jobDeleted', { id });            // the client ignores unknown ids
    void job;
  };
  const onPrinter = (state) => send('printer', slimPrinter(state));

  bus.on('job', onJob);
  bus.on('jobDeleted', onJobDeleted);
  bus.on('printer', onPrinter);

  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off('job', onJob);
    bus.off('jobDeleted', onJobDeleted);
    bus.off('printer', onPrinter);
  });
});

/* --------------------------------------------------------------- registry */

/**
 * Resolve a walk-up printer by its sticker code. The public sheet is what a
 * guest standing in front of the machine should see: how to send the file and
 * (for a shop) what it costs. The checkout that would pay for a shop job is
 * completed by the job pipeline itself once the guest prints.
 */
router.get('/printers/:code', (req, res) => {
  const printers = require('../services/printers');
  const printer = printers.findByCode(req.params.code);
  if (!printer) return res.status(404).json({ error: 'No printer has that code — read the sticker again' });
  res.json({ printer: printers.publicSheet(printer) });
});

/** Read-only quote for a shop printer, keyed off the job's real page count. */
router.get('/printers/:code/quote', (req, res) => {
  const printers = require('../services/printers');
  const printer = printers.findByCode(req.params.code);
  if (!printer) return res.status(404).json({ error: 'No printer has that code — read the sticker again' });
  const job = ownJob(req, res);
  if (!job) return;
  const sheet = printers.publicSheet(printer);
  if (sheet.category !== 'shop' || !sheet.pricing) {
    return res.json({ quote: null, note: 'This printer is not a paid shop — just print.' });
  }
  const pages = job.pageCount;
  const currency = sheet.pricing.currency;
  const color = Number(sheet.pricing.colorPerPage);
  const mono = Number(sheet.pricing.monoPerPage);
  const colorTotal = Math.round(pages * color * 100) / 100;
  const monoTotal = Math.round(pages * mono * 100) / 100;
  res.json({
    quote: {
      printerId: printer.id,
      printerName: printer.name,
      pages,
      currency,
      colour: { perPage: color, total: colorTotal },
      mono: { perPage: mono, total: monoTotal },
    },
    note: 'Share the job on this printer — payment is settled by the printer at the counter.',
  });
});

module.exports = router;
