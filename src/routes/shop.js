'use strict';
/* Shop surface (/api/shop) — the business half of a shop, for the desktop app.
 *
 *   GET  /             this account's document (settings, services, expenses)
 *   POST /sync         fold in the app's copy, hand back the merged one
 *   GET  /reports      revenue (from the machine's paid jobs) − expenses
 *   GET  /reports.csv  the same, flattened for a spreadsheet
 *
 * Everything here is scoped to one owner account and nothing else: signing in to
 * the machine is not enough, because a machine knows how to print, not how to
 * keep books. The account is the licence holder — the shop — and the reports count
 * only jobs that printed at *its* printers.
 *
 * The app owns a copy of the document and works offline (see services/shop.js
 * for the merge protocol). That is why there is no PUT/PATCH per field here:
 * one `sync` carries whatever changed, in either direction, and both sides end
 * up with the same thing.
 */

const express = require('express');
const shop = require('../services/shop');
const log = require('../logger').make('api:shop');

const router = express.Router();

/** Business data belongs to an account. A machine's sign-in is not an account. */
function requireAccount(req, res, next) {
  const scope = req.scope || null;
  if (!scope || !scope.accountId) {
    return res.status(400).json({
      error: 'Sign in with the owner account for this shop — business data belongs to a licence, not to the machine.',
      auth: 'account-required',
    });
  }
  req.accountId = scope.accountId;
  return next();
}

function view(doc) {
  return {
    settings: doc.settings,
    services: doc.services,
    expenses: doc.expenses,
    updatedAt: doc.updatedAt,
    vocabulary: shop.vocabulary(),
  };
}

router.get('/', requireAccount, (req, res) => {
  res.json(view(shop.load(req.accountId)));
});

router.post('/sync', requireAccount, (req, res) => {
  try {
    const merged = shop.merge(req.accountId, req.body && req.body.document ? req.body.document : req.body);
    res.json({ ...view(merged), syncedAt: new Date().toISOString() });
  } catch (error) {
    log.warn(`sync refused for ${req.accountId}: ${error.message}`);
    res.status(error.status || 400).json({ error: error.message });
  }
});

function range(req) {
  const from = String(req.query.from || '').trim().slice(0, 10);
  const to = String(req.query.to || '').trim().slice(0, 10);
  const valid = v => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  return { from: valid(from), to: valid(to) };
}

router.get('/reports', requireAccount, (req, res) => {
  res.json(shop.reports(req.accountId, range(req)));
});

router.get('/reports.csv', requireAccount, (req, res) => {
  const { from, to } = range(req);
  const name = `printbridge-${from || 'start'}-${to || 'today'}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(shop.csv(req.accountId, { from, to }));
});

module.exports = router;
