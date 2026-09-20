'use strict';
/* The shop app's own copy of its business document.
 *
 * Local first means exactly this: the file below is the one the panels read and
 * write, and the machine has a copy that we reconcile with when it is there.
 * A counter that loses its network does not lose the day's expenses, and an
 * expense entered offline is not lost when the machine comes back — the sync
 * merges record by record (src/services/shop.js explains the protocol).
 *
 *   <userData>/shop/<accountId>.json
 *     document      settings, services, expenses — the same shape the API takes
 *     lastSyncedAt  when the machine last agreed with us
 *     dirty         true when this copy has changes the machine has not accepted
 *     lastReport    the last revenue report fetched, so the panel can show it offline
 *
 * One file per account, because one app can hold more than one licence.
 */

const fs = require('fs');
const path = require('path');

let dir = null;

function init({ userData }) {
  dir = path.join(userData, 'shop');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* read-only profile */ }
  return { dir };
}

/** The account id comes from the renderer, so it is never trusted as a path. */
function safeId(accountId) {
  const id = String(accountId || '').trim();
  return /^acc_[A-Za-z0-9_-]{4,40}$/.test(id) ? id : null;
}

function fileFor(accountId) {
  const id = safeId(accountId);
  return id ? path.join(dir, `${id}.json`) : null;
}

function empty() {
  const epoch = new Date(0).toISOString();
  return {
    document: {
      version: 1,
      settings: { currency: 'INR', taxPercent: 0, updatedAt: epoch },
      services: [],
      expenses: [],
    },
    lastSyncedAt: null,
    dirty: false,
    lastReport: null,
  };
}

function load(accountId) {
  const file = fileFor(accountId);
  if (!file) return empty();
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const base = empty();
    return {
      document: saved && saved.document ? saved.document : base.document,
      lastSyncedAt: (saved && saved.lastSyncedAt) || null,
      dirty: Boolean(saved && saved.dirty),
      lastReport: (saved && saved.lastReport) || null,
    };
  } catch {
    return empty();
  }
}

function save(accountId, state) {
  const file = fileFor(accountId);
  if (!file || !state) return false;
  try {
    const payload = {
      document: state.document || empty().document,
      lastSyncedAt: state.lastSyncedAt || null,
      dirty: Boolean(state.dirty),
      lastReport: state.lastReport || null,
      savedAt: new Date().toISOString(),
    };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    return { error: error.message };
  }
}

module.exports = { init, load, save, empty, safeId };
