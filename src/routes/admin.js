'use strict';
/* Admin API (/api/admin) — every control surface, behind one gate.
 *
 *   GET  /session        (open)   who am I, and does this install still need a sign-in
 *   POST /login          (open)   {username, password} → session cookie
 *   POST /logout         (open)   drop this session
 *   ── everything below requires a live admin session ──
 *   POST /credentials             set the username and password (signs all sessions out)
 *   POST /pin                     the old name for the same thing (kept working)
 *   /jobs    /files    /printer    /system
 *
 * The route modules are the original control surface: they manage every job
 * (not just the caller's), which is exactly what makes them admin-only.
 */

const express = require('express');
const auth = require('../auth');
const accounts = require('../services/accounts');
const log = require('../logger').make('api:admin');

const router = express.Router();

/* ------------------------------------------------------------- session */

router.get('/session', (req, res) => {
  res.json(auth.status(req));
});

router.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const open = auth.lockedFor(ip);
  if (open) {
    return res.status(429).json({
      error: `Too many attempts. Try again in ${open}s.`,
      retryAfter: open,
    });
  }

  const body = req.body || {};
  const username = String(body.username || '').trim();
  /* `pin` is the pre-username body: a password with no username, which is what
   * the test suites and any older client still send. It is only ever checked
   * against this machine's own sign-in. */
  const legacyPin = body.pin !== undefined && body.password === undefined;
  const password = String(legacyPin ? body.pin : (body.password || ''));

  if (!password) {
    return res.status(400).json({ error: username ? 'Enter your password' : 'Enter your username and password' });
  }
  if (!username && !legacyPin) {
    return res.status(400).json({ error: 'Enter your username and password' });
  }

  /* Two identities can open the console, and the form takes either:
   *   this machine  its username and password ("admin" unless it was changed)
   *   an owner      the email and password behind a licence */
  let identity = null;
  if (!username) {
    if (auth.verifyPassword(password)) identity = { type: 'machine' };
  } else if (auth.verifyCredentials(username, password)) {
    identity = { type: 'machine' };
  } else {
    /* authenticate() also stamps lastLoginAt and refuses a suspended account. */
    const account = accounts.authenticate(username, password);
    if (account) identity = { type: 'account', account };
  }

  if (!identity) {
    const fails = auth.recordFailure(ip);
    log.warn(`failed console sign-in from ${ip} (${fails} in this window)`);
    const locked = auth.lockedFor(ip);
    return res.status(401).json({
      /* One message for both halves: telling a stranger which usernames exist is
       * free reconnaissance. */
      error: locked ? `Too many attempts. Try again in ${locked}s.` : 'That username and password do not match.',
      retryAfter: locked || 0,
    });
  }

  auth.clearFailures(ip);

  if (identity.type === 'account') {
    const { token, days } = accounts.createSession(req, identity.account);
    res.setHeader('Set-Cookie', accounts.cookieFor(req, token, days));
    log.info(`console signed in as owner ${identity.account.email} from ${ip}`);
    return res.json({
      ...auth.status(req),
      authenticated: true,
      via: 'account',
      account: accounts.view(identity.account),
      expiresAt: new Date(Date.now() + days * 86400 * 1000).toISOString(),
    });
  }

  const { token, days } = auth.createSession(req);
  res.setHeader('Set-Cookie', auth.cookieFor(req, token, days));
  log.info(`console signed in as "${auth.username}" (this machine) from ${ip}`);
  return res.json({
    ...auth.status(req),
    authenticated: true,
    via: 'password',
    username: auth.username,
    expiresAt: new Date(Date.now() + days * 86400 * 1000).toISOString(),
  });
});

router.post('/logout', (req, res) => {
  const session = auth.sessionFrom(req);
  if (session) auth.revoke(session.token);
  res.setHeader('Set-Cookie', auth.clearCookie(req));
  res.json({ ok: true, authenticated: !auth.protected() });
});

/* ---------------------------------------------------------------- gate */

router.use(auth.requireAdmin());

/* ---------------------------------------------------------------- pin */

/**
 * Set the sign-in for this machine.
 *
 * The current password is required even for a live session: a laptop left open
 * on a counter must not be enough to take the console over permanently. The
 * change signs every other device out, because that is the whole point of a
 * password change when you suspect somebody has it.
 */
function setCredentials(req, res, body) {
  const current = String(body.currentPassword !== undefined ? body.currentPassword : (body.currentPin || ''));
  if (auth.protected() && !auth.verifyPassword(current)) {
    auth.recordFailure(req.ip || 'unknown');
    return res.status(401).json({ error: 'That password is not right' });
  }
  const previous = auth.username;
  try {
    auth.setCredentials({ username: body.username, password: body.password });
    const { token, days } = auth.createSession(req);
    res.setHeader('Set-Cookie', auth.cookieFor(req, token, days));
    return res.json({
      ok: true,
      username: auth.username,
      note: previous && previous !== auth.username
        ? `Sign-in changed to "${auth.username}". Other devices were signed out.`
        : 'Password updated. Other devices were signed out.',
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
}

router.post('/credentials', (req, res) => setCredentials(req, res, req.body || {}));

/* The old route, and the old body: a PIN change is now a password change for
 * the same username. Kept so a console a version behind still works. */
router.post('/pin', (req, res) => {
  const body = req.body || {};
  return setCredentials(req, res, {
    currentPassword: body.currentPin,
    username: auth.username || 'admin',
    password: body.nextPin,
  });
});

router.post('/sessions/revoke', (req, res) => {
  auth.revokeAll();
  const { token, days } = auth.createSession(req);
  res.setHeader('Set-Cookie', auth.cookieFor(req, token, days));
  res.json({ ok: true, note: 'Signed out everywhere else.' });
});

/** Sign out everywhere *including* here. */
router.post('/sessions/close-all', (req, res) => {
  auth.revokeAll();
  res.setHeader('Set-Cookie', auth.clearCookie(req));
  res.json({ ok: true });
});

/* ------------------------------------------------------- control suite */

router.use('/jobs', require('./jobs'));
router.use('/files', require('./files'));
router.use('/printer', require('./printer'));
router.use('/printers', require('./printers'));
router.use('/system', require('./system'));

/* One extra admin convenience: the exact URL to hand out to guests. */
router.get('/guest-link', (req, res) => {
  const lan = req.app.get('lanUrl') || `http://${req.headers.host}`;
  res.json({ url: `${lan}/print`, adminUrl: `${lan}/admin` });
});

module.exports = router;
