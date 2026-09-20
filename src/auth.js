'use strict';
/* Machine access control.
 *
 * The guest side of PrintBridge is deliberately open — scan the QR and print.
 * Everything that *changes* the machine (printer choice, defaults, storage,
 * diagnostics, other people's jobs) sits behind a sign-in: a username and a
 * password, scrypt-hashed, exactly like any other console.
 *
 *   data/access.json   username + scrypt hash + salt + sessions (never served)
 *
 * Two identities can open the console, and the difference matters:
 *
 *   this machine   its own username and password, one per install. It sees
 *                  every printer and every job. This is the identity the
 *                  desktop app asks for.
 *   an owner       an email and password created by redeeming a licence code
 *                  (services/accounts.js). It sees only its own printers.
 *
 * On first run the credentials are generated and printed in the startup banner;
 * they can be pre-set with ADMIN_USER / ADMIN_PASSWORD, or reset by deleting
 * data/access.json. An install that still carries an old admin PIN keeps working:
 * the PIN becomes the password of the user "admin", and the app asks for a real
 * password the next time somebody signs in.
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
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 128;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{2,31}$/;
const DEFAULT_USER = 'admin';

/* Readable, unambiguous, and long enough to be worth something: no O/0, l/1,
 * so it can be read off a screen or over the phone without a second try. */
function randomPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 14; i++) out += alphabet[crypto.randomInt(0, alphabet.length)];
  return out;
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
    this.username = '';
    this.salt = '';
    this.hash = '';
    this.sessions = [];
    this.attempts = new Map();      // ip → { fails, first, lockedUntil }
    this.generatedPassword = null;  // only set on first run, for the banner
    this.provisional = false;       // true while the sign-in is not somebody's own choice
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
      if (saved.username) {
        this.username = saved.username;
      } else {
        /* An install from before the console had a username: its PIN becomes the
         * password of "admin". Nobody is locked out and nothing has to be reset,
         * and the app asks for a proper password the next time it is opened. */
        this.username = DEFAULT_USER;
        this.provisional = true;
        log.warn('this install used an admin PIN — it now signs in as "admin" with that PIN as the password; set a real password in the app under Access');
      }
    } else {
      const envUser = String(process.env.ADMIN_USER || '').trim();
      const envPassword = String(process.env.ADMIN_PASSWORD || process.env.ADMIN_PIN || '');
      if (envPassword) {
        this.setCredentials({
          username: USERNAME.test(envUser) ? envUser : DEFAULT_USER,
          password: envPassword,
        }, { silent: true });
        log.info(`console sign-in taken from ${process.env.ADMIN_PASSWORD ? 'ADMIN_PASSWORD' : 'ADMIN_PIN'} (user "${this.username}")`);
        /* An environment variable is the operator's own choice: not provisional. */
        this.provisional = false;
      } else {
        const password = randomPassword();
        this.setCredentials({ username: DEFAULT_USER, password }, { silent: true });
        this.generatedPassword = password;
        this.provisional = true;
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
        version: 2,
        username: this.username,
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

  /* ---------------- credentials ---------------- */

  /** Validate without storing — so a route can say exactly what is wrong. */
  validate({ username, password }) {
    const user = String(username == null ? this.username : username).trim();
    const secret = String(password || '');
    if (username !== undefined && !USERNAME.test(user)) {
      throw new Error('A username is 3–32 characters: letters, digits, dot, dash, underscore');
    }
    if (!secret) throw new Error('Choose a password');
    if (secret.length < MIN_PASSWORD) throw new Error(`A password is at least ${MIN_PASSWORD} characters`);
    if (secret.length > MAX_PASSWORD) throw new Error(`A password is at most ${MAX_PASSWORD} characters`);
    return { username: user, password: secret };
  }

  setCredentials({ username, password }, { silent = false } = {}) {
    const clean = this.validate({ username, password });
    this.username = clean.username;
    this.salt = crypto.randomBytes(16).toString('hex');
    this.hash = crypto.scryptSync(clean.password, this.salt, SCRYPT.keylen, SCRYPT).toString('hex');
    this.updatedAt = new Date().toISOString();
    this.sessions = [];           // changing the sign-in signs everybody out
    this.provisional = false;
    this.generatedPassword = null;
    this.write();
    if (!silent) log.warn(`console sign-in changed for "${this.username}" — all sessions were signed out`);
    return true;
  }

  /** The old name, kept working: sets the password, leaves the username alone. */
  setPin(pin, options = {}) {
    return this.setCredentials({ username: this.username || DEFAULT_USER, password: pin }, options);
  }

  /** Does this password match this machine's sign-in? */
  verifyPassword(password) {
    if (!this.hash || !this.salt) return false;
    let candidate;
    try {
      candidate = crypto.scryptSync(String(password || ''), this.salt, SCRYPT.keylen, SCRYPT).toString('hex');
    } catch {
      return false;
    }
    return safeEqual(candidate, this.hash);
  }

  /** The whole sign-in: the username must match *and* the password must verify. */
  verifyCredentials(username, password) {
    const user = String(username || '').trim();
    if (!user || !this.username) return false;
    /* Constant time on the password even when the username is wrong: an
     * attacker must not be able to tell a valid username from an invalid one
     * by how quickly the answer comes back. */
    const same = user.toLowerCase() === this.username.toLowerCase();
    const passwordOk = this.verifyPassword(password);
    return same && passwordOk;
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
      log.warn(`console sign-in lockout for ${ip} after ${entry.fails} failed attempts (${Math.round(wait / 1000)}s)`);
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

  /** Is the console locked in the first place? (An open LAN install can turn
   * this off, which is why every gate asks rather than assuming.) */
  protected() { return config.get('adminProtect') !== false; }

  /**
   * The account behind this request, if any.
   *
   * Two kinds of session open the console: this machine's own sign-in
   * (whoever set the machine up — the whole machine) and an owner account (one
   * customer, scoped to their own printers). `req.scope` is how a route tells
   * them apart: null means "the whole machine", an accountId means "only
   * theirs".
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
      via: session ? 'password' : own ? 'account' : null,
      username: session ? this.username : null,
      account: own ? accounts.view(own.account) : null,
      /* True while the sign-in is generated or carried over from an old PIN: the
       * app uses this to say, on the Setup checklist, that it still needs doing. */
      needsSetup: this.provisional,
      minPassword: MIN_PASSWORD,
    };
  }
}

module.exports = new Auth();
module.exports.COOKIE = COOKIE;
module.exports.MIN_PASSWORD = MIN_PASSWORD;
module.exports.DEFAULT_USERNAME = DEFAULT_USER;
