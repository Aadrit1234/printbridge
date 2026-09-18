'use strict';
/* Owner / admin printer registry — CRUD over src/services/printers.
 * These are the walk-up printers guests print at; each points at a real
 * backend elsewhere in the bridge and the normal pipeline does the printing. */
const express = require('express');
const printers = require('../services/printers');
const log = require('../logger').make('routes:printers');

const router = express.Router();

/*
 * Who is asking decides what they can see.
 *
 *   req.scope === null              the machine itself (the PIN holder): every
 *                                   printer, including the seeded demo ones
 *   req.scope.accountId === 'acc…' an owner account: only printers they own
 *
 * Scoping lives here rather than in the service so that the guest surface —
 * which resolves a printer by its code — keeps working across all of them.
 */
function visible(req, printer) {
  const scope = req.scope || null;
  if (!scope) return true;
  return printer.accountId === scope.accountId;
}

function scoped(req) {
  const scope = req.scope || null;
  return scope ? printers.all().filter(p => visible(req, p)) : printers.all();
}

/** 404, not 403: an owner should not learn that somebody else's printer exists. */
function find(req, id) {
  const printer = printers.get(id);
  return printer && visible(req, printer) ? printer : null;
}

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
    accountId: p.accountId || null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/* ---------------- CRUD ---------------- */

router.get('/', (req, res) => res.json({ printers: scoped(req).map(adminView), scopedToAccount: Boolean(req.scope) }));

router.post('/', (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    /* The owner of a new printer is the caller, never the request body. */
    body.accountId = req.scope ? req.scope.accountId : (body.accountId || null);
    res.status(201).json({ printer: adminView(printers.create(body)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id', (req, res) => {
  const p = find(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Printer not found' });
  res.json({ printer: adminView(p) });
});

router.patch('/:id', (req, res) => {
  if (!find(req, req.params.id)) return res.status(404).json({ error: 'Printer not found' });
  try {
    const body = { ...(req.body || {}) };
    /* Reassigning an owner through a patch would move a printer out of
     * somebody's account; only the machine itself may do that. */
    if (req.scope) delete body.accountId;
    res.json({ printer: adminView(printers.update(req.params.id, body)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  if (!find(req, req.params.id)) return res.status(404).json({ error: 'Printer not found' });
  printers.remove(req.params.id);
  res.json({ ok: true });
});

/* Convenience for pairing a walk-up code: resolves by code or id. */
router.get('/lookup/:value', (req, res) => {
  const value = String(req.params.value || '').trim();
  const found = printers.findByCode(value) || printers.get(value);
  const p = found && visible(req, found) ? found : null;
  if (!p) return res.status(404).json({ error: 'No printer matches that code' });
  res.json({ printer: adminView(p) });
});

module.exports = router;
