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
 *
 *   <userData>/shop/last-account.json
 *     which licence this computer last used, per machine — see below
 *
 * That second file exists for the case the whole design is for. Working offline
 * needs to know *whose* books are on this laptop, and the only thing that can
 * answer that is the machine — so a shop whose machine was switched off opened
 * on the machine picker and could not reach its own expenses. Remembering the
 * licence locally makes the local copy usable without the network, which is the
 * promise; forgetting it would make "local first" mean "local, when online".
 * Keyed by machine id, because one laptop can be pointed at more than one.
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

/* ---------------- which licence was last used here ---------------- */

function accountsFile() {
  return dir ? path.join(dir, 'last-account.json') : null;
}

function readAccounts() {
  const file = accountsFile();
  if (!file) return {};
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

/**
 * Remember which licence last used this computer, for one machine.
 *
 * The account is kept as the API's own view of it (id, email, name, plan), so a
 * panel can show the licence it is about to read books for without the network.
 */
function rememberAccount(account, machineId = '') {
  const id = account && safeId(account.id);
  if (!id) return false;
  const file = accountsFile();
  if (!file) return false;
  try {
    const all = readAccounts();
    all[String(machineId || '').slice(0, 120)] = {
      account: {
        id,
        email: String(account.email || '').slice(0, 200),
        name: String(account.name || '').slice(0, 120),
        plan: String(account.plan || '').slice(0, 60),
        planLabel: String(account.planLabel || '').slice(0, 60),
        status: String(account.status || '').slice(0, 40),
      },
      at: new Date().toISOString(),
    };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The licence this computer last used, for this machine if it knows one.
 *
 * Falls back to the most recently remembered account, because an app that has
 * been pointed at a machine for a while and then cannot reach it should still
 * find its own books — that is the situation this exists for.
 */
function lastAccount(machineId = '') {
  const all = readAccounts();
  const exact = all[String(machineId || '').slice(0, 120)];
  if (exact && exact.account) return exact;
  const entries = Object.values(all).filter(entry => entry && entry.account);
  if (!entries.length) return null;
  entries.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return entries[0];
}

module.exports = { init, load, save, empty, safeId, rememberAccount, lastAccount };
