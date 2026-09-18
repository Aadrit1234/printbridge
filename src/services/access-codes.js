'use strict';
/* Access codes — the only door to an owner account.
 *
 * When somebody buys a licence they are sent a code like AC-7K4Q-2M9D-X3TB.
 * That code is the whole entitlement: it carries the plan that was paid for,
 * it can be redeemed exactly once, and redeeming it is the *only* way an
 * account can come into existence. Nothing self-serves an account; there is no
 * "sign up" that skips this.
 *
 * Rules, all enforced here rather than in the routes:
 *   • single use          — redeeming burns it, permanently
 *   • plan-bearing        — an account inherits the code's plan, not a request
 *   • optionally bound    — when it was issued for an address, only that
 *                           address may redeem it (the "sent to their mail" case)
 *   • expirable           — a code left in a drawer can be given a deadline
 *   • revocable           — the operator can kill one before it is used
 *
 * Persisted to data/access-codes.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('../logger').make('access-codes');

const GROUP = 4;
const BLOCKS = 3;
const PREFIX = 'AC';
/* The same unambiguous alphabet as printer codes: no 0/O, 1/I or L. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/* The plans a code can carry. Kept here so a code can never invent a plan, and
 * so the amount an operator is owed is never guessed by the callers. */
const PLANS = {
  'workspace-lifetime': { label: 'Workspace', amount: 9999, currency: 'INR', term: 'lifetime', category: 'workspace' },
  'shop-yearly': { label: 'Shop', amount: 499, currency: 'INR', term: 'yearly', category: 'shop' },
  'shop-lifetime': { label: 'Shop', amount: 5999, currency: 'INR', term: 'lifetime', category: 'shop' },
};

let file = null;
let codes = [];
let byCode = new Map();

function block() {
  let out = '';
  for (let i = 0; i < GROUP; i++) out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return out;
}

function newCode() {
  const parts = [];
  for (let i = 0; i < BLOCKS; i++) parts.push(block());
  return `${PREFIX}-${parts.join('-')}`;
}

/**
 * Accepts "AC-7K4Q-2M9D-X3TB", "ac7k4q2m9dx3tb" and "7K4Q2M9DX3TB" as the same
 * code — people read these off an email and retype them.
 */
function normalize(value) {
  const raw = String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const body = (raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw);
  const want = GROUP * BLOCKS;
  if (body.length !== want) return null;
  const parts = [];
  for (let i = 0; i < BLOCKS; i++) parts.push(body.slice(i * GROUP, (i + 1) * GROUP));
  return `${PREFIX}-${parts.join('-')}`;
}

function newId() { return `code_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`; }

function rebuild() {
  byCode = new Map();
  for (const c of codes) if (c.code) byCode.set(c.code, c);
}

function save() {
  if (!file) return;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(codes, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) { log.warn(`save failed: ${e.message}`); }
}

function init(dataDir) {
  file = dataDir ? path.join(dataDir, 'access-codes.json') : null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    codes = (Array.isArray(raw) ? raw : []).filter(c => c && c.code);
  } catch { /* first run */ }
  rebuild();
  return module.exports;
}

/* ---------------- reading ---------------- */

function view(c, { reveal = false } = {}) {
  const out = {
    id: c.id,
    plan: c.plan,
    planLabel: (PLANS[c.plan] || {}).label || c.plan,
    email: c.email || null,
    status: status(c),
    note: c.note || '',
    createdAt: c.createdAt,
    expiresAt: c.expiresAt || null,
    redeemedAt: c.redeemedAt || null,
    redeemedBy: c.redeemedBy || null,
  };
  /* The code itself is only echoed when the operator asks for a freshly minted
   * one — a listing is not a place to leak every key in the drawer. */
  if (reveal) out.code = c.code;
  return out;
}

function status(c) {
  if (c.revokedAt) return 'revoked';
  if (c.redeemedAt) return 'redeemed';
  if (c.expiresAt && new Date(c.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'issued';
}

function all() { return codes.slice(); }
function get(id) { return codes.find(c => c.id === id) || null; }
function findByCode(value) {
  const code = normalize(value);
  if (!code) return null;
  return byCode.get(code) || null;
}

/* ---------------- minting ---------------- */

/**
 * Mint a code for a plan. `email` binds it to one address; `days` gives it a
 * deadline; `note` is for the operator's own bookkeeping (an invoice number,
 * for instance).
 */
function mint({ plan, email = null, note = '', days = null } = {}) {
  const key = String(plan || '').trim();
  if (!PLANS[key]) throw new Error(`Unknown plan "${plan}" — expected one of ${Object.keys(PLANS).join(', ')}`);

  const address = email ? String(email).trim().toLowerCase() : null;
  if (address && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('That email address does not look right');

  let code;
  let guard = 0;
  do {
    code = newCode();
  } while (byCode.has(code) && ++guard < 50);
  if (byCode.has(code)) throw new Error('Could not generate a unique code — try again');

  const expiresAt = Number(days) > 0
    ? new Date(Date.now() + Number(days) * 86400 * 1000).toISOString()
    : null;

  const entry = {
    id: newId(),
    code,
    plan: key,
    email: address,
    note: String(note || '').slice(0, 200),
    createdAt: new Date().toISOString(),
    expiresAt,
    redeemedAt: null,
    redeemedBy: null,
    revokedAt: null,
  };
  codes.push(entry);
  rebuild();
  save();
  log.info(`minted ${key} access code for ${address || 'any address'}`);
  return entry;
}

/* ---------------- redeeming ---------------- */

/**
 * Why a code cannot be used right now, or null when it can.
 * Kept separate from `redeem` so the signup endpoint can explain itself.
 */
function blockingReason(entry, email) {
  if (!entry) return 'That access code does not exist. Check the code in your email.';
  const state = status(entry);
  if (state === 'redeemed') return 'That access code has already been used to create an account.';
  if (state === 'revoked') return 'That access code was cancelled.';
  if (state === 'expired') return 'That access code has expired.';
  if (entry.email && email && entry.email !== String(email).trim().toLowerCase()) {
    return 'That access code was issued to a different email address.';
  }
  if (entry.email && !email) return 'Enter the email address this code was sent to.';
  return null;
}

/**
 * Burn a code and hand back the plan it carried. Single use is enforced by
 * checking-and-writing here, so two simultaneous signups cannot both win.
 */
function redeem(value, { email = null, accountId = null } = {}) {
  const entry = findByCode(value);
  const reason = blockingReason(entry, email);
  if (reason) {
    const err = new Error(reason);
    err.status = 400;
    throw err;
  }
  /* Re-check against the freshest copy in case a concurrent call got here
   * first: status() reads the live object, and `entry` is that same object. */
  if (entry.redeemedAt) {
    const err = new Error('That access code has already been used to create an account.');
    err.status = 400;
    throw err;
  }

  entry.redeemedAt = new Date().toISOString();
  entry.redeemedBy = accountId || null;
  save();
  log.info(`access code redeemed (${entry.plan})`);
  return entry;
}

function revoke(id) {
  const entry = get(id);
  if (!entry) return null;
  if (entry.redeemedAt) throw new Error('That code has already been used and cannot be revoked');
  entry.revokedAt = new Date().toISOString();
  save();
  log.warn('access code revoked before use');
  return entry;
}

module.exports = { init, mint, redeem, revoke, all, get, findByCode, normalize, view, status, blockingReason, PLANS };
