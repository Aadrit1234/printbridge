'use strict';
/* Admin API (/api/admin) — every control surface, behind one gate.
 *
 *   POST /session        (open)   who am I
 *   POST /login          (open)   PIN → session cookie
 *   POST /logout         (open)   drop this session
 *   ── everything below requires a live admin session ──
 *   POST /pin                     change the PIN (signs all sessions out)
 *   /jobs    /files    /printer    /system
 *
 * The route modules are the original control surface: they manage every job
 * (not just the caller's), which is exactly what makes them admin-only.
 */

const express = require('express');
const auth = require('../auth');
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

  const pin = String((req.body || {}).pin || '').trim();
  if (!pin) return res.status(400).json({ error: 'Enter your PIN' });

  if (!auth.verifyPin(pin)) {
    const fails = auth.recordFailure(ip);
    log.warn(`failed admin sign-in from ${ip} (${fails} in this window)`);
    const locked = auth.lockedFor(ip);
    return res.status(401).json({
      error: locked ? `Too many attempts. Try again in ${locked}s.` : 'That PIN is not right.',
      retryAfter: locked || 0,
    });
  }

  auth.clearFailures(ip);
  const { token, days } = auth.createSession(req);
  res.setHeader('Set-Cookie', auth.cookieFor(req, token, days));
  log.info(`admin signed in from ${ip}`);
  return res.json({ ...auth.status(req), authenticated: true, expiresAt: new Date(Date.now() + days * 86400 * 1000).toISOString() });
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

router.post('/pin', (req, res) => {
  const { currentPin, nextPin } = req.body || {};
  // Even open mode (adminProtect off) must know the current PIN to change it.
  if (auth.protected() && !auth.verifyPin(currentPin)) {
    auth.recordFailure(req.ip || 'unknown');
    return res.status(401).json({ error: 'Current PIN is wrong' });
  }
  try {
    auth.setPin(nextPin);
    const { token, days } = auth.createSession(req);
    res.setHeader('Set-Cookie', auth.cookieFor(req, token, days));
    return res.json({ ok: true, note: 'PIN updated. Other devices were signed out.' });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
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
