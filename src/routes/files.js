'use strict';
/* File API — everything the preview UI and downloads need. */

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('../config');
const storage = require('../storage');
const queue = require('../services/queue');
const rasterizer = require('../services/rasterizer');

const router = express.Router();

function jobOr404(req, res) {
  const job = storage.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return null;
  }
  return job;
}

/** The exact PDF that is submitted to the printer. */
router.get('/:id/pdf', (req, res) => {
  const job = jobOr404(req, res);
  if (!job) return;
  if (!job.hasPdf) return res.status(409).json({ error: 'Not converted yet' });
  const file = storage.pdfPath(job);
  if (!fs.existsSync(file)) return res.status(410).json({ error: 'File no longer available' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(job.name.replace(/\.[^.]+$/, ''))}.pdf"`);
  fs.createReadStream(file).pipe(res);
});

router.get('/:id/original', (req, res) => {
  const job = jobOr404(req, res);
  if (!job) return;
  const file = storage.originalPath(job);
  if (!fs.existsSync(file)) return res.status(410).json({ error: 'Original no longer kept' });
  res.download(file, job.name);
});

/** Page preview PNG — rendered on demand and cached on disk. */
router.get('/:id/preview/:page.png', async (req, res) => {
  const job = jobOr404(req, res);
  if (!job) return;
  const page = parseInt(req.params.page, 10);
  if (!Number.isFinite(page)) return res.status(400).json({ error: 'Bad page number' });
  try {
    const file = await queue.ensurePreviewPage(job.id, page);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.sendFile(file);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

router.get('/:id/thumb.png', async (req, res) => {
  const job = jobOr404(req, res);
  if (!job) return;
  const thumb = storage.thumbPath(job);
  if (fs.existsSync(thumb)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(thumb);
  }
  try {
    const page = await queue.ensurePreviewPage(job.id, 1);
    const png = await rasterizer.thumbnail(await fsp.readFile(page), 260);
    await fsp.writeFile(thumb, png);
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch {
    res.status(404).json({ error: 'No thumbnail available' });
  }
});

/** Print-ready files kept outside a printer (outbox backend), newest first. */
router.get('/outbox.json', async (req, res) => {
  try {
    const dir = storage.dirs.outbox;
    const entries = await fsp.readdir(dir);
    const files = [];
    for (const name of entries.slice(-50).reverse()) {
      try {
        const st = await fsp.stat(path.join(dir, name));
        files.push({ name, size: st.size, at: st.mtime.toISOString() });
      } catch { /* skip */ }
    }
    res.json({ dir, files });
  } catch (e) {
    res.json({ dir: storage.dirs.outbox, files: [], error: e.message });
  }
});

router.get('/outbox/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(storage.dirs.outbox, name);
  if (!file.startsWith(storage.dirs.outbox) || !fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(file);
});

/** Page count helper used by the preview UI to lazily extend the page strip. */
router.get('/:id/meta', (req, res) => {
  const job = jobOr404(req, res);
  if (!job) return;
  res.json({
    id: job.id,
    pageCount: job.pageCount,
    renderedPages: job.renderedPages,
    maxPreviewPages: config.get('maxPreviewPages'),
    kind: job.kind,
    hasPdf: job.hasPdf,
  });
});

module.exports = router;
