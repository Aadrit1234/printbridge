'use strict';
/* Job API — upload, inspect, print, cancel, retry, delete. */

const express = require('express');
const storage = require('../storage');
const queue = require('../services/queue');
const log = require('../logger').make('api:jobs');
const { getUploader, decodeName, uploadError, optionsFrom } = require('../upload');

const router = express.Router();

router.post('/', (req, res) => {
  getUploader().array('files', 12)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: uploadError(err) });

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files received' });

    const batchId = String(req.body.batchId || `batch_${Date.now().toString(36)}`);
    const options = optionsFrom(req.body);
    // Jobs created here belong to the admin, so guests never see them.
    const owner = null;

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
          owner,
        }));
      } catch (e) {
        errors.push({ name: decodeName(file.originalname), error: e.message });
        log.warn(`rejected "${file.originalname}": ${e.message}`);
      }
    }
    res.status(jobs.length ? 201 : 422).json({ jobs, errors, batchId });
  });
});

router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const batchId = req.query.batchId ? String(req.query.batchId) : null;
  res.json({ jobs: storage.list({ limit, batchId }).map(storage.summary) });
});

router.get('/:id', (req, res) => {
  const job = storage.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(storage.summary(job));
});

router.post('/:id/print', async (req, res) => {
  try {
    const job = await queue.print(req.params.id, req.body || {});
    res.json(job);
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    res.json(await queue.cancel(req.params.id));
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

router.post('/:id/retry', async (req, res) => {
  try {
    res.json(await queue.retry(req.params.id));
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const job = storage.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (['queued', 'waiting', 'printing'].includes(job.status)) {
    return res.status(409).json({ error: 'Cancel the job before deleting it' });
  }
  await storage.purgeFiles(job);
  storage.remove(job.id);
  res.json({ ok: true });
});

router.delete('/', async (req, res) => {
  const removed = storage.clearTerminal();
  for (const job of removed) await storage.purgeFiles(job);
  res.json({ ok: true, removed: removed.length });
});

module.exports = router;
