/* The shop's own copy of its books — local first.
 *
 * Every business panel reads and writes *this*, never the network. The machine
 * has a copy too, and the two are reconciled record by record (the merge is in
 * src/services/shop.js); when the machine is away, everything still works and
 * the changes wait. That is the whole point: a counter that loses Wi-Fi must
 * not lose the day's expenses, and a shop's takings are not the machine's to
 * hold hostage.
 *
 *   local copy   <userData>/shop/<accountId>.json — written by the main process
 *   the machine  /api/shop — reached through the app's own host
 *
 * The rules this file keeps:
 *   • a change is written locally first, always, and only then pushed;
 *   • a failed push marks the copy dirty rather than discarding anything;
 *   • a pull never overwrites a dirty copy — that is how a laptop eats a day of
 *     work while somebody is on the counter with the network down.
 */

import { ownerApi, shopApi, desktop } from './api.js';

let state = null;      // { accountId, document, lastSyncedAt, dirty, lastReport }
let account = null;
const listeners = new Set();
let syncing = false;

function emit() {
  for (const fn of listeners) {
    try { fn(state); } catch { /* a broken panel must not stop the others */ }
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function get() {
  return state;
}

export function signedInAccount() {
  return account;
}

export function ready() {
  return Boolean(state && state.accountId);
}

function epoch() {
  return new Date(0).toISOString();
}

function emptyDocument() {
  return {
    version: 1,
    settings: { currency: 'INR', taxPercent: 0, updatedAt: epoch() },
    services: [],
    expenses: [],
  };
}

function isEmpty(document) {
  if (!document) return true;
  return (!document.expenses || !document.expenses.length)
    && (!document.services || !document.services.length)
    && (!document.settings || !document.settings.updatedAt || document.settings.updatedAt === epoch());
}

/** Which licence is signed in — the books belong to it and to nobody else. */
export async function load() {
  const session = await ownerApi.session().catch(() => null);
  account = session && session.account ? session.account : null;
  if (!account) {
    state = null;
    emit();
    return null;
  }

  const local = (await desktop.shop.load(account.id).catch(() => null)) || {};
  state = {
    accountId: account.id,
    document: local.document || emptyDocument(),
    lastSyncedAt: local.lastSyncedAt || null,
    dirty: Boolean(local.dirty),
    lastReport: local.lastReport || null,
  };

  /* A brand-new install has nothing local: take the machine's copy. Never do
   * this over a dirty copy — that is somebody's unsent work. */
  if (!state.lastSyncedAt && isEmpty(state.document)) await pull();
  emit();
  return state;
}

async function persist() {
  if (!state) return;
  await desktop.shop.save(state.accountId, {
    document: state.document,
    lastSyncedAt: state.lastSyncedAt,
    dirty: state.dirty,
    lastReport: state.lastReport,
  }).catch(() => null);
}

/** Take the machine's copy. Refused while this copy has unsent changes. */
export async function pull() {
  if (!state) return { ok: false, error: 'No licence is signed in' };
  if (state.dirty) return { ok: false, error: 'This copy has changes the machine has not accepted yet — syncing instead' };
  try {
    const doc = await shopApi.document();
    state.document = {
      version: 1,
      settings: doc.settings || emptyDocument().settings,
      services: doc.services || [],
      expenses: doc.expenses || [],
    };
    state.lastSyncedAt = new Date().toISOString();
    state.dirty = false;
    await persist();
    emit();
    return { ok: true, at: state.lastSyncedAt };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** Push this copy and take back the merged one. Both sides end up the same. */
export async function sync({ force = false } = {}) {
  if (!state) return { ok: false, error: 'No licence is signed in' };
  if (syncing && !force) return { ok: false, error: 'already syncing' };
  if (!state.dirty && !force) return { ok: true, skipped: true, at: state.lastSyncedAt };
  syncing = true;
  try {
    const merged = await shopApi.sync(state.document);
    state.document = {
      version: 1,
      settings: merged.settings || state.document.settings,
      services: merged.services || [],
      expenses: merged.expenses || [],
    };
    state.lastSyncedAt = new Date().toISOString();
    state.dirty = false;
    await persist();
    emit();
    return { ok: true, at: state.lastSyncedAt };
  } catch (error) {
    state.dirty = true;
    await persist();
    emit();
    return { ok: false, error: error.message };
  } finally {
    syncing = false;
  }
}

/* ---------------- the only way things change ---------------- */

/**
 * Change something locally, then try to tell the machine. The local write never
 * depends on the network, and a failure only marks the copy dirty — so the
 * panel can always say "saved here, not yet at the machine" and be right.
 */
async function edit(mutator) {
  if (!state) return { ok: false, error: 'No licence is signed in' };
  mutator(state.document);
  state.dirty = true;
  await persist();
  emit();
  return sync();
}

function find(list, id) {
  return (list || []).find(record => record.id === id) || null;
}

export function liveExpenses() {
  return (state && state.document.expenses ? state.document.expenses : [])
    .filter(record => !record.deletedAt)
    .sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1));
}

export function liveServices() {
  return (state && state.document.services ? state.document.services : [])
    .filter(record => !record.deletedAt);
}

export function settings() {
  return (state && state.document.settings) || emptyDocument().settings;
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function saveExpense(record) {
  const now = new Date().toISOString();
  const id = (record && record.id) || newId('exp');
  return edit((document) => {
    const existing = find(document.expenses, id);
    const next = {
      id,
      date: record.date,
      category: record.category,
      vendor: record.vendor || '',
      note: record.note || '',
      amount: Number(record.amount) || 0,
      currency: record.currency || settings().currency || 'INR',
      updatedAt: now,
      deletedAt: null,
    };
    if (existing) Object.assign(existing, next);
    else document.expenses.push(next);
  });
}

export async function deleteExpense(id) {
  const now = new Date().toISOString();
  return edit((document) => {
    const existing = find(document.expenses, id);
    /* A tombstone, not a splice: the machine and any other laptop have to hear
     * about the delete, or the next sync brings the row back. */
    if (existing) Object.assign(existing, { deletedAt: now, updatedAt: now });
  });
}

export async function saveService(record) {
  const now = new Date().toISOString();
  const id = (record && record.id) || newId('svc');
  return edit((document) => {
    const existing = find(document.services, id);
    const next = {
      id,
      label: record.label,
      kind: record.kind || 'flat',
      amount: Number(record.amount) || 0,
      currency: record.currency || settings().currency || 'INR',
      note: record.note || '',
      updatedAt: now,
      deletedAt: null,
    };
    if (existing) Object.assign(existing, next);
    else document.services.push(next);
  });
}

export async function deleteService(id) {
  const now = new Date().toISOString();
  return edit((document) => {
    const existing = find(document.services, id);
    if (existing) Object.assign(existing, { deletedAt: now, updatedAt: now });
  });
}

export async function saveSettings(patch) {
  const now = new Date().toISOString();
  return edit((document) => {
    document.settings = { ...document.settings, ...patch, updatedAt: now };
  });
}

/** Remember the last revenue report, so the panel can show it with no machine. */
export async function rememberReport(report) {
  if (!state) return;
  state.lastReport = report;
  await persist();
}

/** One line for the panels to show: is the machine holding the same numbers? */
export function syncState() {
  if (!state) return { kind: 'none', text: 'no licence signed in' };
  if (state.dirty) return { kind: 'pending', text: 'saved here — not yet at the machine' };
  if (state.lastSyncedAt) return { kind: 'synced', text: `in step with the machine · ${new Date(state.lastSyncedAt).toLocaleString()}` };
  return { kind: 'local', text: 'held on this computer only' };
}
