'use strict';
/* Owner accounts — one per customer (a workspace, a shop, a campus desk).
 *
 * Accounts are tenants. Everything a customer owns hangs off one: their
 * printers, and eventually their jobs and defaults. Crucially, an account is
 * *never* created by signing up in the ordinary sense — it can only come into
 * existence by redeeming an access code, so an account always corresponds to
 * something that was actually bought (see services/access-codes.js).
 *
 * Passwords are scrypt hashed with a per-account salt, exactly like this
 * machine's own sign-in, and a session is an opaque token in an HttpOnly cookie. Sessions are
 * persisted, so a restart does not sign everybody out.
 *
 * Persisted to data/accounts.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('../logger').make('accounts');
const cookies = require('../cookies');
const { PLANS } = require('./access-codes');

const COOKIE = 'pb_owner';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_PASSWORD = 8;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let file = null;
let accounts = [];
let sessions = [];
let byId = new Map();
let byEmail = new Map();

function newId() { return `acc_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`; }

function rebuild() {
  byId = new Map();
  byEmail = new Map();
  for (const a of accounts) {
    byId.set(a.id, a);
    if (a.email) byEmail.set(a.email, a);
  }
}

function save() {
  if (!file) return;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, accounts, sessions }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) { log.warn(`save failed: ${e.message}`); }
}

function init(dataDir) {
  file = dataDir ? path.join(dataDir, 'accounts.json') : null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    accounts = (Array.isArray(raw && raw.accounts) ? raw.accounts : []).filter(a => a && a.id && a.email);
    sessions = (Array.isArray(raw && raw.sessions) ? raw.sessions : []).filter(s => s && s.token);
  } catch { /* first run */ }
  rebuild();
  prune();
  return module.exports;
}

/* ---------------- passwords ---------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, stored) {
  if (!stored || !stored.hash || !stored.salt) return false;
  let candidate;
  try {
    candidate = crypto.scryptSync(String(password || ''), stored.salt, SCRYPT.keylen, SCRYPT).toString('hex');
  } catch {
    return false;
  }
  const a = Buffer.from(candidate);
  const b = Buffer.from(stored.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }

/* ---------------- accounts ---------------- */

function view(a) {
  if (!a) return null;
  const plan = PLANS[a.plan] || null;
  return {
    id: a.id,
    email: a.email,
    name: a.name || '',
    plan: a.plan,
    planLabel: plan ? plan.label : a.plan,
    planTerm: plan ? plan.term : null,
    status: a.status,
    createdAt: a.createdAt,
    lastLoginAt: a.lastLoginAt || null,
  };
}

function all() { return accounts.slice(); }
function get(id) { return byId.get(id) || null; }
function findByEmail(value) { return byEmail.get(normalizeEmail(value)) || null; }

/**
 * The only way an account is born. `plan` comes from the redeemed access code,
 * never from the caller, so an account cannot award itself a licence.
 */
function create({ email, name = '', password, plan } = {}) {
  const address = normalizeEmail(email);
  if (!EMAIL.test(address)) throw new Error('Enter a valid email address');
  if (byEmail.has(address)) throw new Error('An account already exists for that email — sign in instead');
  if (String(password || '').length < MIN_PASSWORD) throw new Error(`Choose a password of at least ${MIN_PASSWORD} characters`);
  if (!PLANS[plan]) throw new Error('That licence plan is not recognised');

  const account = {
    id: newId(),
    email: address,
    name: String(name || '').trim().slice(0, 80),
    plan,
    status: 'active',
    password: hashPassword(String(password)),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  accounts.push(account);
  rebuild();
  save();
  log.info(`created account ${account.email} (${plan})`);
  return account;
}

function update(id, patch = {}) {
  const account = get(id);
  if (!account) throw new Error('Account not found');
  if (patch.name !== undefined) account.name = String(patch.name).trim().slice(0, 80);
  if (patch.password !== undefined) {
    if (String(patch.password).length < MIN_PASSWORD) throw new Error(`Choose a password of at least ${MIN_PASSWORD} characters`);
    account.password = hashPassword(String(patch.password));
    sessions = sessions.filter(s => s.accountId !== id);   // a new password signs the old sessions out
  }
  if (patch.status !== undefined) account.status = patch.status === 'suspended' ? 'suspended' : 'active';
  account.updatedAt = new Date().toISOString();
  save();
  return account;
}

function remove(id) {
  const before = accounts.length;
  accounts = accounts.filter(a => a.id !== id);
  if (accounts.length === before) return false;
  sessions = sessions.filter(s => s.accountId !== id);
  rebuild();
  save();
  log.warn('account deleted');
  return true;
}

/** Email + password → the account, or null. */
function authenticate(email, password) {
  const account = findByEmail(email);
  if (!account || account.status !== 'active') return null;
  if (!verifyPassword(password, account.password)) return null;
  account.lastLoginAt = new Date().toISOString();
  save();
  return account;
}

/* ---------------- sessions ---------------- */

function sessionDays() {
  const days = Number(require('../config').get('sessionDays'));
  return Number.isFinite(days) && days >= 1 ? Math.min(days, 365) : 30;
}

function prune() {
  const now = Date.now();
  const before = sessions.length;
  sessions = sessions.filter(s => s && s.expiresAt > now);
  if (sessions.length !== before) save();
}

function createSession(req, account) {
  const token = crypto.randomBytes(32).toString('hex');
  const days = sessionDays();
  sessions.push({
    token,
    accountId: account.id,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + days * 86400 * 1000,
    ip: String(req.ip || '').slice(0, 60),
    agent: String(req.headers['user-agent'] || '').slice(0, 160),
  });
  prune();
  save();
  return { token, days };
}

function sessionFrom(req) {
  if (!req) return null;
  const token = cookies.parse(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const session = sessions.find(s => s.token === token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions = sessions.filter(s => s.token !== token);
    save();
    return null;
  }
  return session;
}

function revoke(token) {
  const before = sessions.length;
  sessions = sessions.filter(s => s.token !== token);
  if (sessions.length !== before) save();
  return sessions.length !== before;
}

function revokeAllFor(accountId) {
  sessions = sessions.filter(s => s.accountId !== accountId);
  save();
}

function cookieFor(req, token, days) { return cookies.build(COOKIE, token, { req, days }); }
function clearCookie(req = null) { return cookies.clear(COOKIE, req); }

module.exports = {
  init, create, update, remove, get, all, findByEmail, authenticate,
  view, createSession, sessionFrom, revoke, revokeAllFor, cookieFor, clearCookie,
  hashPassword, verifyPassword, COOKIE, MIN_PASSWORD,
};
