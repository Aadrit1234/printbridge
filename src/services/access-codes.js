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
 * so the amount an operator is owed is never guessed by the callers — the
 * website, the checkout and the mails all read their prices and features from
 * this one place. */
const PLANS = {
  'workspace-lifetime': {
    label: 'Workspace',
    amount: 6999,
    currency: 'INR',
    term: 'lifetime',
    category: 'workspace',
    blurb: 'An office, a floor or a shared desk: one queue, a code on the machine, and everyone prints to it from their own phone.',
    features: [
      'Lifetime licence for one machine — pay once, keep it, updates included',
      'Guests print from their phone after scanning one code: no app, no account',
      'Unlimited printer codes — rename, share or revoke any of them',
      'The app sets the printer up itself: plug it in, it goes wireless and gets a code',
      'Print codes, tokens, job history and reprints included',
      'Up to 10 documents in one print command, 25 MB each',
      'Workspace console app for Windows, and the same console in a browser tab',
    ],
  },
  'shop-yearly': {
    label: 'Shop',
    amount: 499,
    currency: 'INR',
    term: 'yearly',
    category: 'shop',
    blurb: 'For print shops that want the whole business half without paying for it once: the same console, billed a year at a time.',
    features: [
      'Everything in Workspace, licensed for a year',
      'Charge by the page, in colour and black & white, at rates you set',
      'Guests pay before a sheet moves — checkout at the counter or on their phone',
      "Today's takings, per-job margin and expenses in the owner's app",
      'Shop console app with pricing manager, expenses and reports',
      'Every printer you register sits under one licence',
    ],
  },
  'shop-lifetime': {
    label: 'Shop',
    amount: 11999,
    currency: 'INR',
    term: 'lifetime',
    category: 'shop',
    blurb: 'The whole shop, bought once. For a counter that is not going anywhere and would rather never see a renewal.',
    features: [
      'Everything in Workspace, plus the whole business half',
      'Charge by the page, in colour and black & white, at rates you set',
      'Guests pay before a sheet moves — checkout at the counter or on their phone',
      "Today's takings, per-job margin and expenses in the owner's app",
      'Shop console app with pricing manager, expenses and reports',
      'Every printer you register sits under one licence — no renewal, ever',
      'Updates for the life of the product',
    ],
  },
};

/* A code's prefix says at a glance what was bought — WS for a workspace, SH for
 * a shop — so the two kinds can never be confused in an inbox or over a
 * counter. The prefix is cosmetic: the plan stored with the code is what
 * decides what it unlocks, and codes minted before the prefixes existed (AC-)
 * still redeem exactly as they did. */
const PREFIXES = { workspace: 'WS', shop: 'SH' };
const ANY_PREFIX = /^(AC|WS|SH)/;

let file = null;
let codes = [];
let byCode = new Map();

function block() {
  let out = '';
  for (let i = 0; i < GROUP; i++) out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return out;
}

function newCode(prefix = PREFIX) {
  const parts = [];
  for (let i = 0; i < BLOCKS; i++) parts.push(block());
  return `${prefix}-${parts.join('-')}`;
}

/**
 * Accepts "WS-7K4Q-2M9D-X3TB", "ws7k4q2m9dx3tb" and "7K4Q2M9DX3TB" as the same
 * code — people read these off an email and retype them, and nobody remembers
 * the prefix. Returns the body only, which is what codes are looked up by, so a
 * code keeps working whichever prefix the person typed (or was sent).
 */
function normalize(value) {
  const raw = String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const body = raw.replace(ANY_PREFIX, '');
  const want = GROUP * BLOCKS;
  if (body.length !== want) return null;
  const parts = [];
  for (let i = 0; i < BLOCKS; i++) parts.push(body.slice(i * GROUP, (i + 1) * GROUP));
  return parts.join('-');
}

function newId() { return `code_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`; }

function rebuild() {
  byCode = new Map();
  for (const c of codes) {
    const key = normalize(c.code);
    if (key) byCode.set(key, c);
  }
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
    category: (PLANS[c.plan] || {}).category || null,
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
  const key = normalize(value);
  if (!key) return null;
  return byCode.get(key) || null;
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

  const prefix = PREFIXES[PLANS[key].category] || PREFIX;
  let code;
  let guard = 0;
  do {
    code = newCode(prefix);
  } while (byCode.has(normalize(code)) && ++guard < 50);
  if (byCode.has(normalize(code))) throw new Error('Could not generate a unique code — try again');

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

/**
 * Drop a code record entirely. Vendor-only, for support: a test code, a code
 * issued to the wrong address, a licence that had to be reissued. Revoking is
 * the gentler tool — it leaves the paper trail — so prefer that when the code
 * was ever in somebody's hands.
 */
function remove(id) {
  const index = codes.findIndex(c => c.id === id || normalize(c.code) === normalize(id));
  if (index === -1) return null;
  const [entry] = codes.splice(index, 1);
  rebuild();
  save();
  log.warn('access code removed from the ledger');
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

module.exports = {
  init, mint, redeem, revoke, remove, all, get, findByCode, normalize, view, status, blockingReason,
  PLANS, PREFIXES,
};
