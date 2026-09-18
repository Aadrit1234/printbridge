'use strict';
/* Owner surface (/api/owner) — accounts, and the operator's code desk.
 *
 *   ── open ──
 *   GET  /plans                 what a licence costs, in INR
 *   GET  /session               who is signed in (if anyone)
 *   POST /signup                { code, email, name, password } → account + session
 *   POST /login                 { email, password } → session
 *   POST /logout                drop this session
 *   ── account session ──
 *   GET    /account             this account
 *   PATCH  /account             rename, or change the password
 *   ── operator (OPERATOR_KEY) ──
 *   GET  /codes                 every access code ever issued
 *   POST /codes                 mint one: { plan, email?, note?, days? }
 *   POST /codes/:id/revoke      kill an unused code
 *   GET  /accounts              every account (support, not day-to-day)
 *
 * There is deliberately no "sign up without a code". An account exists because
 * a licence was bought, and the code that proves it is the only thing that can
 * create one — see services/access-codes.js.
 */

const express = require('express');
const crypto = require('crypto');
const auth = require('../auth');
const accounts = require('../services/accounts');
const codes = require('../services/access-codes');
const config = require('../config');
const log = require('../logger').make('api:owner');

const router = express.Router();

/* ---------------- open ---------------- */

router.get('/plans', (req, res) => {
  res.json({
    currency: 'INR',
    plans: Object.entries(codes.PLANS).map(([id, p]) => ({
      id,
      label: p.label,
      amount: p.amount,
      currency: p.currency,
      term: p.term,
      category: p.category,
    })),
  });
});

router.get('/session', (req, res) => {
  const own = auth.accountSession(req);
  res.json({
    authenticated: Boolean(own),
    account: own ? accounts.view(own.account) : null,
    expiresAt: own ? new Date(own.session.expiresAt).toISOString() : null,
    sessionDays: Number(config.get('sessionDays')) || 30,
    cookieName: accounts.COOKIE,
  });
});

/**
 * Redeem an access code into an account. This is the whole registration flow:
 * the code is burned here, and the account it creates inherits the code's plan
 * rather than anything the caller sent.
 */
router.post('/signup', (req, res) => {
  const body = req.body || {};
  const codeValue = String(body.code || '').trim();
  if (!codeValue) return res.status(400).json({ error: 'Enter the access code from your email' });

  /* Explain a bad code before creating anything — and say nothing about
   * whether an account already exists for the address, which is not this
   * endpoint's business to leak. */
  const existing = codes.findByCode(codeValue);
  const blocked = codes.blockingReason(existing, body.email);
  if (blocked) return res.status(400).json({ error: blocked });

  let account;
  try {
    account = accounts.create({
      email: body.email,
      name: body.name,
      password: body.password,
      plan: existing.plan,          // the code decides the plan, never the request
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    codes.redeem(codeValue, { email: body.email, accountId: account.id });
  } catch (e) {
    /* The code stopped being usable between the check and here (almost
     * certainly a double-submit). Do not leave an account nobody paid for. */
    accounts.remove(account.id);
    return res.status(400).json({ error: e.message });
  }

  const { token, days } = accounts.createSession(req, account);
  res.setHeader('Set-Cookie', accounts.cookieFor(req, token, days));
  log.info(`account created from an access code (${account.plan})`);
  return res.status(201).json({
    account: accounts.view(account),
    expiresAt: new Date(Date.now() + days * 86400 * 1000).toISOString(),
  });
});

router.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const locked = auth.lockedFor(ip);
  if (locked) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${locked}s.`, retryAfter: locked });
  }

  const body = req.body || {};
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password' });

  const account = accounts.authenticate(email, password);
  if (!account) {
    const fails = auth.recordFailure(ip);
    log.warn(`failed owner sign-in from ${ip} (${fails} in this window)`);
    const nowLocked = auth.lockedFor(ip);
    return res.status(401).json({
      error: nowLocked ? `Too many attempts. Try again in ${nowLocked}s.` : 'That email and password do not match an account.',
      retryAfter: nowLocked || 0,
    });
  }

  auth.clearFailures(ip);
  const { token, days } = accounts.createSession(req, account);
  res.setHeader('Set-Cookie', accounts.cookieFor(req, token, days));
  log.info('owner signed in');
  return res.json({
    account: accounts.view(account),
    expiresAt: new Date(Date.now() + days * 86400 * 1000).toISOString(),
  });
});

router.post('/logout', (req, res) => {
  const session = accounts.sessionFrom(req);
  if (session) accounts.revoke(session.token);
  res.setHeader('Set-Cookie', accounts.clearCookie(req));
  res.json({ ok: true, authenticated: false });
});

/* ---------------- account session ---------------- */

function requireAccount(req, res, next) {
  const own = auth.accountSession(req);
  if (!own) return res.status(401).json({ error: 'Sign in to continue', auth: 'required' });
  req.own = own.account;
  return next();
}

router.get('/account', requireAccount, (req, res) => {
  res.json({ account: accounts.view(req.own) });
});

router.patch('/account', requireAccount, (req, res) => {
  const body = req.body || {};
  try {
    const updated = accounts.update(req.own.id, { name: body.name, password: body.password });
    /* A password change signs the old sessions out, including this one, so
     * hand back a fresh session rather than a cookie that is already dead. */
    const { token, days } = accounts.createSession(req, updated);
    res.setHeader('Set-Cookie', accounts.cookieFor(req, token, days));
    return res.json({ account: accounts.view(updated), note: body.password ? 'Password changed. Other devices were signed out.' : 'Saved.' });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

router.get('/printers', requireAccount, (req, res) => {
  const printers = require('../services/printers');
  const mine = printers.all().filter(p => p.accountId === req.own.id);
  res.json({ printers: mine.map(p => ({ id: p.id, name: p.name, code: p.code, category: p.category, active: Boolean(p.active) })) });
});

/* ---------------- operator ---------------- */

/**
 * The operator key is the *vendor's* key, not a customer's: it mints the codes
 * that licences are sold as. It only ever comes from the environment, so a
 * deployment either has one or the desk is closed. There is no default and no
 * "first run" generation — a guessable vendor key would be worse than none.
 */
function operatorKey() {
  const key = String(process.env.OPERATOR_KEY || '').trim();
  return key.length >= 16 ? key : null;
}

function requireOperator(req, res, next) {
  const expected = operatorKey();
  if (!expected) {
    return res.status(503).json({
      error: 'No operator key is configured. Set OPERATOR_KEY (16+ characters) in .env and restart to issue access codes.',
      operatorConfigured: false,
    });
  }
  const given = String(req.headers['x-operator-key'] || (req.body && req.body.operatorKey) || req.query.key || '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    log.warn(`refused an operator request from ${req.ip || 'unknown'}`);
    return res.status(401).json({ error: 'That operator key is not right' });
  }
  return next();
}

router.get('/codes', requireOperator, (req, res) => {
  const all = codes.all().slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ codes: all.map(c => codes.view(c)), plans: Object.keys(codes.PLANS), operatorConfigured: true });
});

/**
 * Mint a code. This is the manual path that exists until the payment webhook
 * does it automatically, so it returns the code itself — the operator has to
 * be able to read it out and email it.
 */
router.post('/codes', requireOperator, (req, res) => {
  const body = req.body || {};
  try {
    const entry = codes.mint({
      plan: body.plan,
      email: body.email,
      note: body.note,
      days: body.days,
    });
    log.info('operator minted an access code');
    return res.status(201).json({ code: codes.view(entry, { reveal: true }) });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

router.post('/codes/:id/revoke', requireOperator, (req, res) => {
  try {
    const entry = codes.revoke(req.params.id);
    if (!entry) return res.status(404).json({ error: 'No such access code' });
    return res.json({ code: codes.view(entry) });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

router.get('/accounts', requireOperator, (req, res) => {
  res.json({ accounts: accounts.all().map(accounts.view) });
});

/**
 * Remove an account. Support, not day-to-day: a customer who never got set up,
 * or one who wants their data gone. Their printers stay in the registry but
 * stop being visible to any account — the machine can still see and reassign
 * them, which is what keeps this recoverable.
 */
router.delete('/accounts/:id', requireOperator, (req, res) => {
  const account = accounts.get(req.params.id);
  if (!account) return res.status(404).json({ error: 'No such account' });
  accounts.remove(account.id);
  log.warn('operator removed an account');
  return res.json({ ok: true, printersKept: require('../services/printers').all().filter(p => p.accountId === account.id).length });
});

module.exports = router;
