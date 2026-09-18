'use strict';
/* Admin access control.
 *
 * The guest side of PrintBridge is deliberately open — scan the QR and print.
 * Everything that *changes* the machine (printer choice, defaults, storage,
 * diagnostics, other people's jobs) sits behind /admin and a PIN.
 *
 *   data/access.json   scrypt hash + salt + active sessions (never served)
 *
 * A random 6-digit PIN is generated on first run and printed in the startup
 * banner. It can be changed in Admin → Access, pre-set with the ADMIN_PIN
 * environment variable, or reset by deleting data/access.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const cookies = require('./cookies');
const accounts = require('./services/accounts');
const log = require('./logger').make('auth');

const COOKIE = 'pb_admin';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAX_FAILS = 5;          // failures before the first lockout
const BASE_LOCK_MS = 30 * 1000;
const MAX_LOCK_MS = 15 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;

function randomPin() {
  // 6 digits, no leading-zero ambiguity in practice — it is read off a screen.
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, '0');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const parseCookies = cookies.parse;

class Auth {
  constructor() {
    this.file = null;
    this.salt = '';
    this.hash = '';
    this.sessions = [];
    this.attempts = new Map();      // ip → { fails, first, lockedUntil }
    this.generatedPin = null;       // only set on first run, for the banner
    this.updatedAt = null;
  }

  init(dataDir) {
    this.file = path.join(dataDir, 'access.json');
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }

    if (saved && saved.hash && saved.salt) {
      this.salt = saved.salt;
      this.hash = saved.hash;
      this.sessions = Array.isArray(saved.sessions) ? saved.sessions : [];
      this.updatedAt = saved.updatedAt || null;
    } else {
      const envPin = process.env.ADMIN_PIN;
      if (envPin) {
        this.setPin(envPin, { silent: true });
        log.info('admin PIN taken from the ADMIN_PIN environment variable');
      } else {
        const pin = randomPin();
        this.setPin(pin, { silent: true });
        this.generatedPin = pin;
      }
    }
    this._prune();
    this.write();
    return this;
  }

  /* ---------------- persistence ---------------- */

  write() {
    if (!this.file) return;
    try {
      const tmp = this.file + '.tmp';
      const payload = {
        version: 1,
        salt: this.salt,
        hash: this.hash,
        updatedAt: this.updatedAt,
        sessions: this.sessions,
      };
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      log.error(`could not save access.json: ${e.message}`);
    }
  }

  _prune() {
    const now = Date.now();
    const before = this.sessions.length;
    this.sessions = this.sessions.filter(s => s && s.expiresAt > now);
    if (this.sessions.length !== before) this.write();
  }

  /* ---------------- pin ---------------- */

  setPin(pin, { silent = false } = {}) {
    const value = String(pin || '').trim();
    if (!/^[0-9a-zA-Z]{4,32}$/.test(value)) {
      throw new Error('PIN must be 4–32 letters or digits');
    }
    this.salt = crypto.randomBytes(16).toString('hex');
    this.hash = crypto.scryptSync(value, this.salt, SCRYPT.keylen, SCRYPT).toString('hex');
    this.updatedAt = new Date().toISOString();
    this.sessions = [];           // changing the PIN signs everybody out
    this.write();
    if (!silent) log.warn('admin PIN changed — all admin sessions were signed out');
    return true;
  }

  verifyPin(pin) {
    if (!this.hash || !this.salt) return false;
    let candidate;
    try {
      candidate = crypto.scryptSync(String(pin || ''), this.salt, SCRYPT.keylen, SCRYPT).toString('hex');
    } catch {
      return false;
    }
    return safeEqual(candidate, this.hash);
  }

  /* ---------------- brute-force guard ---------------- */

  _entry(ip) {
    let entry = this.attempts.get(ip);
    if (!entry || Date.now() - entry.first > WINDOW_MS) {
      entry = { fails: 0, first: Date.now(), lockedUntil: 0 };
      this.attempts.set(ip, entry);
    }
    return entry;
  }

  lockedFor(ip) {
    const entry = this._entry(ip);
    const left = entry.lockedUntil - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  recordFailure(ip) {
    const entry = this._entry(ip);
    entry.fails += 1;
    if (entry.fails >= MAX_FAILS) {
      const over = entry.fails - MAX_FAILS;
      const wait = Math.min(BASE_LOCK_MS * Math.pow(2, over), MAX_LOCK_MS);
      entry.lockedUntil = Date.now() + wait;
      log.warn(`admin PIN lockout for ${ip} after ${entry.fails} failed attempts (${Math.round(wait / 1000)}s)`);
    }
    return entry.fails;
  }

  clearFailures(ip) { this.attempts.delete(ip); }

  /* ---------------- sessions ---------------- */

  sessionDays() {
    const days = Number(config.get('sessionDays'));
    return Number.isFinite(days) && days >= 1 ? Math.min(days, 365) : 30;
  }

  createSession(req) {
    const token = crypto.randomBytes(32).toString('hex');
    const days = this.sessionDays();
    this.sessions.push({
      token,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + days * 86400 * 1000,
      ip: String(req.ip || '').slice(0, 60),
      agent: String(req.headers['user-agent'] || '').slice(0, 160),
    });
    this._prune();
    this.write();
    return { token, days };
  }

  sessionFrom(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const session = this.sessions.find(s => s.token === token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions = this.sessions.filter(s => s.token !== token);
      this.write();
      return null;
    }
    return session;
  }

  revoke(token) {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter(s => s.token !== token);
    if (this.sessions.length !== before) this.write();
  }

  revokeAll() { this.sessions = []; this.write(); }

  /**
   * Strict same-site cookies are the safe default and stay the default. When
   * the admin console is hosted on another origin (an allowlisted one, see
   * cors.js) the cookie has to travel cross-site, and browsers only accept that
   * with SameSite=None; Secure — which also means it is only ever sent over
   * HTTPS. That is a deliberate, configured trade-off, not an accident.
   */
  cookieFor(req, token, days) {
    return cookies.build(COOKIE, token, { req, days });
  }

  clearCookie(req = null) {
    return cookies.clear(COOKIE, req);
  }

  /* ---------------- gate ---------------- */

  protected() { return config.get('adminProtect') !== false; }

  /**
   * The account behind this request, if any.
   *
   * Two kinds of session open the control room: the machine PIN (whoever set
   * this server up — the whole machine) and an owner account (one customer,
   * scoped to their own printers). `req.scope` is how a route tells them
   * apart: null means "the whole machine", an accountId means "only theirs".
   */
  accountSession(req) {
    const session = accounts.sessionFrom(req);
    if (!session) return null;
    const account = accounts.get(session.accountId);
    if (!account || account.status !== 'active') return null;
    return { session, account };
  }

  /** Express middleware: everything mounted behind it needs a live session. */
  requireAdmin() {
    return (req, res, next) => {
      if (!this.protected()) { req.admin = { open: true }; req.scope = null; return next(); }

      const session = this.sessionFrom(req);
      if (session) {
        req.admin = { type: 'machine', ...session };
        req.scope = null;
        return next();
      }

      const own = this.accountSession(req);
      if (own) {
        req.admin = { type: 'account', accountId: own.account.id, email: own.account.email, name: own.account.name };
        req.scope = { accountId: own.account.id };
        return next();
      }

      return res.status(401).json({ error: 'Admin sign-in required', auth: 'required' });
    };
  }

  status(req) {
    const session = this.protected() ? this.sessionFrom(req) : null;
    const own = session || !this.protected() ? null : this.accountSession(req);
    return {
      protected: this.protected(),
      authenticated: !this.protected() || Boolean(session) || Boolean(own),
      open: !this.protected(),
      expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
      sessionDays: this.sessionDays(),
      updatedAt: this.updatedAt,
      cookieName: COOKIE,
      /* Who is actually signed in: the machine, one account, or nobody. */
      via: session ? 'pin' : own ? 'account' : null,
      account: own ? accounts.view(own.account) : null,
    };
  }
}

module.exports = new Auth();
module.exports.COOKIE = COOKIE;
