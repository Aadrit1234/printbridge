'use strict';
/* Owner / admin printer registry — CRUD over src/services/printers.
 * These are the walk-up printers guests print at; each points at a real
 * backend elsewhere in the bridge and the normal pipeline does the printing. */
const express = require('express');
const printers = require('../services/printers');
const log = require('../logger').make('routes:printers');

const router = express.Router();

/* The object shape the backend of the queue expects when it prints: the
 * destination string plus the fixed public fields. */
function adminView(p) {
  return {
    id: p.id,
    name: p.name,
    note: p.note || '',
    code: p.code,
    category: p.category,
    active: Boolean(p.active),
    capabilities: p.capabilities,
    target: printers.targetString(p),
    pricing: p.pricing || null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/* ---------------- CRUD ---------------- */

router.get('/', (req, res) => res.json({ printers: printers.all().map(adminView) }));

router.post('/', (req, res) => {
  try {
    res.status(201).json({ printer: adminView(printers.create(req.body || {})) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id', (req, res) => {
  const p = printers.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Printer not found' });
  res.json({ printer: adminView(p) });
});

router.patch('/:id', (req, res) => {
  try {
    res.json({ printer: adminView(printers.update(req.params.id, req.body || {})) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  if (!printers.remove(req.params.id)) return res.status(404).json({ error: 'Printer not found' });
  res.json({ ok: true });
});

/* Convenience for pairing a walk-up code: resolves by code or id. */
router.get('/lookup/:value', (req, res) => {
  const value = String(req.params.value || '').trim();
  const p = printers.findByCode(value) || printers.get(value);
  if (!p) return res.status(404).json({ error: 'No printer matches that code' });
  res.json({ printer: adminView(p) });
});

module.exports = router;
