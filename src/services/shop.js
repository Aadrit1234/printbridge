'use strict';
/* Shop business data: the things a printing business knows that a machine does not.
 *
 * A machine knows what it printed. A *shop* knows what it spent, what it sells
 * besides printing, and what its money is worth in a period. That is this file:
 *
 *   data/shop/<accountId>.json
 *     settings   currency, tax rate — the shop's, not the machine's
 *     services   extra things charged for: lamination, binding, scanning
 *     expenses   paper, ink, toner, maintenance, wages, rent
 *
 * What is deliberately NOT stored here: the per-page prices the queue charges.
 * Those live on the printer (`printers.pricing`) because they are what a guest's
 * checkout is computed from, and a copy of that in a second place is a bug
 * waiting to happen — the pricing panel edits the printer itself, live.
 *
 * ── syncing ────────────────────────────────────────────────────────────────
 * The shop app keeps its own copy of this document and works offline; this is
 * the machine's copy, and the two are reconciled record by record. Every record
 * carries `updatedAt`, and a delete sets `deletedAt` instead of removing it, so
 * a delete on the laptop is not resurrected by the machine's older copy or the
 * other way round. Newest wins; a tombstone is pruned after 90 days, by which
 * time both sides have certainly seen it. That is the whole protocol, and it is
 * the only one an offline-first pair of copies can agree on without a clock to
 * trust.
 */

const fs = require('fs');
const path = require('path');
const storage = require('../storage');
const printers = require('./printers');
const log = require('../logger').make('shop');

const TOMBSTONE_DAYS = 90;
const MAX_EXPENSES = 5000;
const MAX_SERVICES = 200;
const MAX_JOBS_SCANNED = 20000;

const CATEGORIES = ['paper', 'ink', 'toner', 'maintenance', 'rent', 'electricity', 'wages', 'transport', 'other'];
const KINDS = ['perPage', 'perJob', 'flat'];

let dir = null;
const cache = new Map();

function init(dataDir) {
  dir = path.join(dataDir, 'shop');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { log.error(`could not create the shop folder: ${e.message}`); }
  cache.clear();
  return validate();
}

function validate() {
  return { dir };
}

function fileFor(accountId) {
  return path.join(dir, `${accountId}.json`);
}

function emptyDoc(accountId) {
  const epoch = new Date(0).toISOString();
  return {
    version: 1,
    accountId,
    updatedAt: epoch,
    settings: { currency: 'INR', taxPercent: 0, updatedAt: epoch },
    services: [],
    expenses: [],
  };
}

/* ---------------- storage ---------------- */

function load(accountId) {
  if (cache.has(accountId)) return cache.get(accountId);
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(fileFor(accountId), 'utf8'));
  } catch { /* first sync for this account */ }
  const clean = sanitize(doc, accountId) || emptyDoc(accountId);
  cache.set(accountId, clean);
  return clean;
}

function save(doc) {
  if (!dir) return false;
  try {
    const tmp = `${fileFor(doc.accountId)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, fileFor(doc.accountId));
    cache.set(doc.accountId, doc);
    return true;
  } catch (e) {
    log.error(`could not save shop data for ${doc.accountId}: ${e.message}`);
    return false;
  }
}

/* ---------------- sanitising ---------------- */

const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

function iso(value, fallback = null) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  const time = Date.parse(text);
  if (!Number.isFinite(time)) return fallback;
  return new Date(time).toISOString();
}

function day(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = iso(text);
  return parsed ? parsed.slice(0, 10) : null;
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

/** A record is a payload plus the two fields the merge protocol needs. */
function record(payload, fields, stamp) {
  const id = text(payload && payload.id, 60);
  if (!id) return null;
  const out = { id, updatedAt: iso(payload.updatedAt, stamp), deletedAt: iso(payload.deletedAt, null) };
  for (const [key, kind] of Object.entries(fields)) {
    const value = payload ? payload[key] : undefined;
    if (kind === 'money') out[key] = money(value);
    else if (kind === 'day') out[key] = day(value);
    else if (kind === 'enum') out[key] = value;
    else out[key] = text(value, kind);
  }
  return out;
}

const EXPENSE_FIELDS = { date: 'day', category: 'enum', vendor: 80, note: 200, amount: 'money', currency: 'enum' };
const SERVICE_FIELDS = { label: 80, kind: 'enum', amount: 'money', currency: 'enum', note: 200 };

function sanitizeList(list, fields, { max, enums }) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list.slice(0, max)) {
    const item = record(raw, fields, new Date(0).toISOString());
    if (!item) continue;
    for (const [key, allowed] of Object.entries(enums)) {
      if (item[key] != null && !allowed.includes(item[key])) item[key] = null;
    }
    out.push(item);
  }
  return out;
}

function sanitize(doc, accountId) {
  if (!doc || typeof doc !== 'object') return null;
  const epoch = new Date(0).toISOString();
  const settings = doc.settings && typeof doc.settings === 'object' ? doc.settings : {};
  return {
    version: 1,
    accountId,
    updatedAt: iso(doc.updatedAt, epoch),
    settings: {
      currency: ['INR', 'USD', 'EUR', 'GBP', 'AED'].includes(settings.currency) ? settings.currency : 'INR',
      taxPercent: Math.max(0, Math.min(100, Number(settings.taxPercent) || 0)),
      updatedAt: iso(settings.updatedAt, epoch),
    },
    services: sanitizeList(doc.services, SERVICE_FIELDS, { max: MAX_SERVICES, enums: { kind: KINDS, currency: ['INR', 'USD', 'EUR', 'GBP', 'AED'] } }),
    expenses: sanitizeList(doc.expenses, EXPENSE_FIELDS, { max: MAX_EXPENSES, enums: { category: CATEGORIES, currency: ['INR', 'USD', 'EUR', 'GBP', 'AED'] } }),
  };
}

/* ---------------- merging ---------------- */

/**
 * Newest wins, per record. A tombstone is a record too — it just says "gone on
 * this date" — so a delete travels the same road as an edit and the later of
 * the two always decides.
 */
function mergeList(mine, theirs) {
  const byId = new Map();
  for (const record of mine) byId.set(record.id, record);
  for (const record of theirs) {
    const current = byId.get(record.id);
    if (!current || record.updatedAt >= current.updatedAt) byId.set(record.id, record);
  }
  return [...byId.values()];
}

function prune(list, now) {
  const cutoff = new Date(now - TOMBSTONE_DAYS * 86400 * 1000).toISOString();
  return list.filter(r => !(r.deletedAt && r.deletedAt < cutoff));
}

function sortExpenses(list) {
  return list.sort((a, b) => (a.date === b.date ? String(a.id).localeCompare(String(b.id)) : String(a.date) < String(b.date) ? 1 : -1));
}

function sortServices(list) {
  return list.sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
}

/**
 * Fold an incoming copy into the machine's copy and hand back the result — the
 * caller gets back everything it did not have, and keeps everything it did.
 */
function merge(accountId, incoming) {
  const now = Date.now();
  const mine = load(accountId);
  const theirs = sanitize(incoming, accountId);
  if (!theirs) {
    const error = new Error('That is not a shop document');
    error.status = 400;
    throw error;
  }

  const next = {
    version: 1,
    accountId,
    updatedAt: new Date(now).toISOString(),
    settings: theirs.settings.updatedAt >= mine.settings.updatedAt ? theirs.settings : mine.settings,
    services: sortServices(prune(mergeList(mine.services, theirs.services), now)),
    expenses: sortExpenses(prune(mergeList(mine.expenses, theirs.expenses), now)),
  };
  save(next);
  return next;
}

/* ---------------- reports ---------------- */

/** Every printer this account owns — the only jobs that count as its revenue. */
function ownedPrinterIds(accountId) {
  return new Set(printers.all().filter(p => p.accountId === accountId).map(p => p.id));
}

function inRange(date, from, to) {
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function blank(day) {
  return { date: day, jobs: 0, pages: 0, revenue: 0, expenses: 0, net: 0 };
}

function add(target, key, entry) {
  if (!target.has(key)) target.set(key, entry);
  return target.get(key);
}

/**
 * Revenue comes from the machine (paid jobs, recomputed by the queue — never
 * from a browser's estimate). Expenses come from the shop's own document. Net is
 * the subtraction, and it is the number a shop actually opens this panel for.
 */
function reports(accountId, { from = '', to = '' } = {}) {
  const doc = load(accountId);
  const ids = ownedPrinterIds(accountId);
  const currency = doc.settings.currency || 'INR';

  const totals = { jobs: 0, pages: 0, revenue: 0, expenses: 0, net: 0, unpaidJobs: 0 };
  const byDay = new Map();
  const byPrinter = new Map();
  const byMode = new Map();
  const byCategory = new Map();
  const names = new Map(printers.all().map(p => [p.id, p.name || p.id]));

  for (const job of storage.list({ limit: MAX_JOBS_SCANNED })) {
    /* A job records where it was headed in its options (that is what the walk-up
     * code resolved to) and, once paid, in its payment. Either names a printer
     * this shop owns or it does not — free workspace jobs included. */
    const printerId = (job.options && job.options.printer) || (job.payment && job.payment.printer) || '';
    if (!ids.has(printerId)) continue;
    const when = day(job.printedAt || job.createdAt);
    if (!inRange(when, from, to)) continue;
    if (job.superseded || job.system) continue;

    const paid = Boolean(job.payment && job.payment.paid);
    const amount = paid ? money(job.payment.amount) || 0 : 0;
    const pages = Number(job.pageCount) || 0;
    const mode = (job.payment && job.payment.mode) || (job.options && job.options.mode) || 'mono';

    totals.jobs += 1;
    totals.pages += pages;
    totals.revenue += amount;
    if (!paid) totals.unpaidJobs += 1;

    const dayRow = add(byDay, when, blank(when));
    dayRow.jobs += 1;
    dayRow.pages += pages;
    dayRow.revenue += amount;

    const printerRow = add(byPrinter, printerId, { printerId, name: names.get(printerId) || printerId, jobs: 0, pages: 0, revenue: 0 });
    printerRow.jobs += 1;
    printerRow.pages += pages;
    printerRow.revenue += amount;

    const modeRow = add(byMode, mode, { mode, jobs: 0, pages: 0, revenue: 0 });
    modeRow.jobs += 1;
    modeRow.pages += pages;
    modeRow.revenue += amount;
  }

  for (const expense of doc.expenses) {
    if (expense.deletedAt || !inRange(expense.date, from, to)) continue;
    const amount = money(expense.amount) || 0;
    totals.expenses += amount;
    const dayRow = add(byDay, expense.date, blank(expense.date));
    dayRow.expenses += amount;
    const categoryRow = add(byCategory, expense.category || 'other', { category: expense.category || 'other', amount: 0, count: 0 });
    categoryRow.amount += amount;
    categoryRow.count += 1;
  }

  const days = [...byDay.values()]
    .map(row => ({ ...row, net: Math.round((row.revenue - row.expenses) * 100) / 100 }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  totals.net = Math.round((totals.revenue - totals.expenses) * 100) / 100;
  totals.tax = Math.round(totals.revenue * (doc.settings.taxPercent / 100) * 100) / 100;

  return {
    accountId,
    currency,
    from: from || null,
    to: to || null,
    totals: {
      ...totals,
      revenue: Math.round(totals.revenue * 100) / 100,
      expenses: Math.round(totals.expenses * 100) / 100,
    },
    byDay: days,
    byPrinter: [...byPrinter.values()].sort((a, b) => b.revenue - a.revenue),
    byMode: [...byMode.values()].sort((a, b) => b.jobs - a.jobs),
    byCategory: [...byCategory.values()].sort((a, b) => b.amount - a.amount),
  };
}

/** The same report, flattened, for a spreadsheet or an accountant. */
function csv(accountId, range) {
  const report = reports(accountId, range);
  const rows = [['date', 'jobs', 'pages', 'revenue', 'expenses', 'net', 'currency']];
  for (const row of report.byDay.slice().reverse()) {
    rows.push([row.date, row.jobs, row.pages, row.revenue.toFixed(2), row.expenses.toFixed(2), row.net.toFixed(2), report.currency]);
  }
  rows.push(['total', report.totals.jobs, report.totals.pages, report.totals.revenue.toFixed(2), report.totals.expenses.toFixed(2), report.totals.net.toFixed(2), report.currency]);
  return rows.map(r => r.join(',')).join('\n') + '\n';
}

/** What the panel offers in its dropdowns, so the app does not invent its own. */
function vocabulary() {
  return { categories: CATEGORIES, kinds: KINDS, currencies: ['INR', 'USD', 'EUR', 'GBP', 'AED'] };
}

module.exports = { init, load, save, sanitize, merge, reports, csv, vocabulary, CATEGORIES, KINDS };
