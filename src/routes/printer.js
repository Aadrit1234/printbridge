'use strict';
/* Printer API — status, discovery, connection choice, test page, tooling. */

const express = require('express');
const config = require('../config');
const storage = require('../storage');
const log = require('../logger').make('api:printer');
const registry = require('../services/backends/registry');
const queue = require('../services/queue');
const watchdog = require('../services/watchdog');
const windows = require('../services/tools/windows');
const render = require('../services/render');

const router = express.Router();

router.get('/status', async (req, res) => {
  const snapshot = await registry.state({ fresh: req.query.fresh === '1' });
  res.json(snapshot);
});

router.get('/backends', async (req, res) => {
  const out = [];
  for (const id of registry.ORDER) {
    const backend = registry.BACKENDS[id];
    // eslint-disable-next-line no-await-in-loop
    const available = await backend.available().catch(() => false);
    out.push({ id, label: backend.label, kind: backend.kind, available });
  }
  res.json({ backends: out, selected: config.get('backend') });
});

/** Find nearby printers: local Windows queues, CUPS queues, mDNS, optional scan. */
router.post('/locate', async (req, res) => {
  const { mdns = true, scan = false } = req.body || {};
  try {
    const found = await registry.locate({ mdns, scan, timeoutMs: scan ? 12000 : 8000 });
    res.json(found);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Choose the connection: backend + queue/URL. */
router.post('/select', async (req, res) => {
  const { backend, spoolerQueue, cupsQueue, printerUrl } = req.body || {};
  try {
    const patch = {};
    if (backend) patch.backend = backend;
    if (spoolerQueue !== undefined) patch.spoolerQueue = spoolerQueue;
    if (cupsQueue !== undefined) patch.cupsQueue = cupsQueue;
    if (printerUrl !== undefined) patch.printerUrl = printerUrl;
    config.patch(patch);
    registry.invalidate();
    log.info(`connection updated: ${JSON.stringify(patch)}`);
    res.json(await registry.state({ fresh: true }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Refresh the state right away (used by the Refresh button). */
router.post('/refresh', async (req, res) => {
  registry.invalidate();
  res.json(await watchdog.refreshPrinter({ silent: false }) || await registry.state({ fresh: true }));
});

/** Wake a sleeping network printer (and re-check the connection afterwards). */
router.post('/wake', async (req, res) => {
  try {
    const result = await registry.wake();
    registry.invalidate();
    const snapshot = result.ok ? await registry.state({ fresh: true }) : null;
    res.json({ ...result, printer: snapshot });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Print a test page through the normal job pipeline so it shows up in the queue. */
router.post('/test', async (req, res) => {
  try {
    const snapshot = await registry.state({ fresh: true });
    const pdfBytes = await render.testPagePdf({
      printerName: snapshot.state.name,
      backendLabel: snapshot.active.label,
      serverUrl: req.app.get('lanUrl') || `http://${req.headers.host}`,
    });
    const job = await queue.createFromPdf({ pdfBytes, name: 'PrintBridge test page.pdf' });
    await queue.print(job.id, {});
    res.json({ job: storage.summary(storage.get(job.id)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Presence of the helper tools that make silent USB printing possible. */
router.get('/tools', async (req, res) => {
  const [tools, office] = await Promise.all([
    windows.toolsStatus().catch(() => ({ sumatra: null, adobe: null, winget: null, ready: false })),
    render.hasOfficeSupport().catch(() => false),
  ]);
  res.json({
    platform: process.platform,
    silentPrintReady: tools.ready,
    sumatra: tools.sumatra,
    adobe: tools.adobe,
    winget: tools.winget,
    libreoffice: office,
  });
});

/** Install SumatraPDF (winget → portable download fallback). */
router.post('/tools/sumatra', async (req, res) => {
  if (process.platform !== 'win32') {
    return res.status(400).json({ error: 'This helper is only needed on Windows' });
  }
  try {
    const result = await windows.installSumatra(msg => log.info(msg));
    registry.invalidate();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Live queue depth for the selected Windows queue (used by the connection card). */
router.get('/queue-depth', async (req, res) => {
  const name = config.get('spoolerQueue');
  if (!name) return res.json({ depth: null });
  const depth = await windows.queueJobCount(name).catch(() => null);
  res.json({ queue: name, depth });
});

module.exports = router;
