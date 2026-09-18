'use strict';
/* The printer registry — printers an owner has activated so walk-up guests can
 * print to them with a code. Two categories, exactly as the product is split:
 *
 *   workspace — a printer on an office floor or campus; guests print for free,
 *               one copy at a time, whatever the printer can physically do.
 *   shop      — "smoke & colour" print shops / businesses; every page is priced
 *               (colour vs black & white), a checkout happens before printing,
 *               and walk-up guests must pay before the job is sent.
 *
 * Every entry is a *real* printer elsewhere in PrintBridge: it points at one of
 * the print backends (Windows spooler queue, IPP, CUPS, outbox) and the normal
 * job pipeline does the actual printing — registry entries just decide where a
 * job goes and whether it has been paid for.
 *
 * Persisted to data/printers.json. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const log = require('../logger').make('printers');
const config = require('../config');

const cat = config; /* alias, keeps the code below short */

const GROUP = 4;
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CATEGORIES = ['workspace', 'shop'];
const TARGET_KINDS = ['outbox', 'spooler', 'ipp', 'cups'];
const ALL_PAPERS = ['a4', 'letter', 'legal', 'a5'];
const ALL_ORIENTATIONS = ['portrait', 'landscape'];
const CURRENCIES = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };

let file = null;
let printers = [];
let byId = new Map();
let byCode = new Map();
let byTarget = new Map();

function block() {
  let out = '';
  for (let i = 0; i < GROUP; i++) out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return out;
}

function newCode() { return `PP-${block()}-${block()}`; }

function normalizeCode(value) {
  const raw = String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (raw.length !== GROUP * 2) return null;
  return `PP-${raw.slice(0, GROUP)}-${raw.slice(GROUP)}`;
}

function newId() { return `prt_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`; }

function rebuildIndex() {
  byId = new Map();
  byCode = new Map();
  byTarget = new Map();
  for (const p of printers) {
    byId.set(p.id, p);
    if (p.code) byCode.set(p.code, p);
    if (p.targetId) byTarget.set(p.targetId, p);
  }
}

function save() {
  if (!file) return;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(printers, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) { log.warn(`save failed: ${e.message}`); }
}

function init(dataDir) {
  file = dataDir ? path.join(dataDir, 'printers.json') : null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    printers = (Array.isArray(raw) ? raw : []).filter(p => p && p.id);
  } catch { /* first run */ }
  rebuildIndex();
}

/* ---------------- validation ---------------- */

function sanitize(input) {
  const p = input || {};
  const out = {
    id: p.id || newId(),
    name: String(p.name || '').trim().slice(0, 80),
    note: String(p.note || '').trim().slice(0, 200),
    code: normalizeCode(p.code) || newCode(),
    category: CATEGORIES.includes(p.category) ? p.category : 'workspace',
    active: p.active === undefined ? true : Boolean(p.active),
    capabilities: {
      papers: Array.isArray(p.capabilities && p.capabilities.papers)
        ? p.capabilities.papers.filter(k => ALL_PAPERS.includes(k))
        : ['a4'],
      orientations: Array.isArray(p.capabilities && p.capabilities.orientations)
        ? p.capabilities.orientations.filter(k => ALL_ORIENTATIONS.includes(k))
        : ALL_ORIENTATIONS,
      duplex: Boolean(p.capabilities && p.capabilities.duplex),
      color: Boolean(p.capabilities && p.capabilities.color),
    },
    targetId: p.targetId ? String(p.targetId).slice(0, 120) : null,
    target: String(p.target || p.targetId || '').trim().slice(0, 300) || null,
    pricing: null,
  };
  if (!out.name) throw new Error('Give this printer a name');
  if (out.capabilities.papers.length === 0) out.capabilities.papers = ['a4'];

  if (out.category === 'shop') {
    const pricing = p.pricing || {};
    const currency = CURRENCIES[pricing.currency] ? pricing.currency : 'INR';
    const color = Number(pricing.colorPerPage);
    const mono = Number(pricing.monoPerPage);
    if (!Number.isFinite(color) || color < 0 || !Number.isFinite(mono) || mono < 0) {
      throw new Error('Set a colour and a black & white price per page');
    }
    out.pricing = { currency, colorPerPage: color, monoPerPage: mono };
  }
  return out;
}

function uniqueCode() {
  const taken = new Set(printers.map(p => p.code));
  for (let i = 0; i < 60; i++) {
    const code = newCode();
    if (!taken.has(code)) return code;
  }
  return `${newCode()}${crypto.randomInt(0, 9)}`;
}

/* ---------------- CRUD ---------------- */

function all() { return [...printers]; }
function list() { return all(); }
function get(id) { return byId.get(id) || null; }
function findByCode(code) {
  const c = normalizeCode(code);
  if (!c) return null;
  return byCode.get(c) || null;
}
function findByTarget(targetId) { return targetId ? (byTarget.get(targetId) || null) : null; }

function create(input) {
  const entry = sanitize(input);
  if (!entry.code || byCode.has(entry.code)) entry.code = uniqueCode();
  entry.createdAt = new Date().toISOString();
  entry.updatedAt = entry.createdAt;
  printers.unshift(entry);
  rebuildIndex();
  save();
  log.info(`printer "${entry.name}" registered as ${entry.code} (${entry.category})`);
  return entry;
}

function update(id, patch = {}) {
  const existing = get(id);
  if (!existing) throw new Error('Printer not found');
  Object.assign(existing, sanitize({ ...existing, ...patch, id: existing.id }), { updatedAt: new Date().toISOString() });
  rebuildIndex();
  save();
  return existing;
}

function remove(id) {
  const existing = get(id);
  if (!existing) return false;
  printers = printers.filter(p => p.id !== id);
  rebuildIndex();
  save();
  log.info(`printer "${existing.name}" (${existing.code}) removed`);
  return true;
}

/** The public "shallow" view a printer code gives walk-up guests. */
function publicSheet(p) {
  return {
    code: p.code,
    name: p.name,
    note: p.note || '',
    category: p.category,
    active: Boolean(p.active),
    capabilities: p.capabilities,
    pricing: p.pricing || null,
  };
}

/**
 * The destination string queue.js sends to the backend that actually prints:
 * the owner's chosen target (spooler:NAME / ipp://… / cups:QUEUE / outbox),
 * or the target id the printer points at when no explicit target was kept.
 */
function targetString(p) {
  if (!p) return '';
  const explicit = String(p.target || '').trim();
  if (explicit) return explicit.slice(0, 300);
  const fromTarget = p.target && typeof p.target === 'object'
    ? (p.target.queue ? `${p.target.kind || 'spooler'}:${p.target.queue}` : String(p.target.url || ''))
    : '';
  if (fromTarget.trim()) return fromTarget.slice(0, 300);
  if (p.targetId) return `outbox:${String(p.targetId).slice(0, 120)}`;
  return '';
}

module.exports = { init, all, list, get, findByCode, findByTarget, create, update, remove, publicSheet, normalizeCode, targetString };
