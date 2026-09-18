'use strict';
/* System API — meta, settings, live events (SSE), logs, diagnostics, pairing. */

const express = require('express');
const os = require('os');
const QRCode = require('qrcode');
const config = require('../config');
const storage = require('../storage');
const bus = require('../events');
const logger = require('../logger');
const log = logger.make('api:system');
const registry = require('../services/backends/registry');
const queue = require('../services/queue');
const render = require('../services/render');

const router = express.Router();
const VERSION = require('../../package.json').version;

/* ---------------- meta & settings ---------------- */

router.get('/meta', (req, res) => {
  res.json({
    app: config.get('appName'),
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    lanUrl: req.app.get('lanUrl'),
    addresses: req.app.get('lanAddresses') || [],
    hostname: os.hostname(),
    serverTime: new Date().toISOString(),
    features: { batchUpload: true, sse: true, lazyPreviews: true, office: true },
  });
});

router.get('/settings', (req, res) => res.json(config.all()));

router.patch('/settings', (req, res) => {
  try {
    const before = config.get('maxUploadMb');
    const all = config.patch(req.body || {});
    if (all.maxUploadMb !== before) log.info(`upload limit changed to ${all.maxUploadMb} MB`);
    res.json(all);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------------- live events ---------------- */

router.get('/events', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, payload) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ }
  };

  const printer = await registry.state().catch(() => null);
  send('hello', {
    at: new Date().toISOString(),
    jobs: storage.list({ limit: 100 }).map(storage.summary),
    printer,
    settings: config.all(),
    logs: logger.recent(60),
    outbox: storage.dirs.outbox,
  });

  const onJob = (job) => send('job', job);
  const onJobDeleted = (payload) => send('jobDeleted', payload);
  const onPrinter = (snapshot) => send('printer', snapshot);
  const onLog = (entry) => send('log', entry);
  const onSettings = (payload) => send('settings', payload);

  bus.on('job', onJob);
  bus.on('jobDeleted', onJobDeleted);
  bus.on('printer', onPrinter);
  bus.on('log', onLog);
  bus.on('settings', onSettings);

  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off('job', onJob);
    bus.off('jobDeleted', onJobDeleted);
    bus.off('printer', onPrinter);
    bus.off('log', onLog);
    bus.off('settings', onSettings);
  });
});

router.get('/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 400);
  res.json({ logs: logger.recent(limit) });
});

/* ---------------- diagnostics & storage ---------------- */

router.get('/diagnostics', async (req, res) => {
  const [diag, usage] = await Promise.all([registry.diagnostics(), storage.usage()]);
  res.json({ ...diag, storage: usage, uptimeSeconds: Math.round(process.uptime()) });
});

router.get('/storage', async (req, res) => res.json(await storage.usage()));

router.post('/storage/cleanup', async (req, res) => {
  const removed = await storage.cleanup({ retentionHours: config.get('retentionHours'), maxJobs: 200 });
  res.json({ ok: true, removed });
});

/* ---------------- pairing ---------------- */

function pairingUrl(req) {
  const lan = req.app.get('lanUrl');
  // Accept both ?url= (poster download) and ?data= (QR image cache-buster).
  // The QR points at the walk-up print app, not the marketing page.
  return String(req.query.url || req.query.data || (lan ? `${lan}/print` : '') || `http://${req.headers.host}/print`);
}

router.get('/pairing/qr.png', async (req, res) => {
  try {
    const png = await QRCode.toBuffer(await pairingUrl(req), { width: 520, margin: 2 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(png);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function pairingLines() {
  return [
    '1. Join the Wi-Fi network this server is on.',
    '2. Scan the QR code (or type the address above).',
    '3. Pick a file, check the preview, press Print.',
    '4. Keep the print code (PB-XXXX-XXXX) to follow it in the queue.',
  ];
}

/** Download / preview the printable pairing card. */
router.get('/pairing/card.pdf', async (req, res) => {
  try {
    const pdfBytes = await render.qrCardPdf({
      title: config.get('appName'),
      url: pairingUrl(req),
      lines: pairingLines(),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="printbridge-qr-card.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Print the pairing card through the real print pipeline. */
router.post('/pairing/card/print', async (req, res) => {
  try {
    const pdfBytes = await render.qrCardPdf({
      title: config.get('appName'),
      url: pairingUrl(req),
      lines: pairingLines(),
    });
    const job = await queue.createFromPdf({ pdfBytes, name: 'PrintBridge QR card.pdf' });
    await queue.print(job.id, {});
    res.json({ job: storage.summary(storage.get(job.id)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
