'use strict';
/* Cross-origin access, for when the frontend is hosted somewhere else.
 *
 * Self-hosted, this does nothing: the app and the API share an origin, so no
 * CORS headers are needed and none are sent. When the frontend is deployed to a
 * static host (Vercel, Netlify, GitHub Pages), the browser treats the API as
 * cross-origin, and two things are required:
 *
 *   1. an explicit allowlist — read from ALLOWED_ORIGINS, a comma-separated
 *      list of exact origins, e.g. "https://printbridge.vercel.app"
 *   2. cookie credentials — the admin session cookie must be sent cross-site,
 *      which means SameSite=None; Secure (see auth.js) and
 *      Access-Control-Allow-Credentials on every response
 *
 * Anything not on the allowlist gets no CORS headers, so the browser refuses to
 * let another site read the response — that is why the allowlist is an explicit
 * list of origins rather than a wildcard.
 *
 * A page and the service both on loopback are the same machine, however their
 * ports differ: the desktop app serves its console from an ephemeral loopback
 * port and proxies to the service on another one, and a dev server on 5173 does
 * the same. Those are allowed without an allowlist entry — a local page was
 * served by software on this machine anyway — but they are still cross-origin
 * as far as the browser is concerned, so they get the headers like anyone else.
 * The session cookie stays Strict for them: localhost to localhost is the same
 * *site* (only the port differs), so Strict is sent and is the safer choice.
 *
 * And when an allowlist *is* configured, a cross-site request from an origin
 * that is not on it is refused outright (403). No CORS headers alone would let
 * a page on another site still *trigger* requests it cannot read — a form post
 * to /api/v1/jobs prints a document — which is not a theory worth tolerating on
 * a server that can reach a printer. Requests with no Origin header (curl,
 * native apps, health checks, a service manager) and same-origin calls are
 * unaffected, and with no allowlist configured nothing changes at all.
 *
 * Preflight (OPTIONS) is answered before the admin gate: a preflight carries no
 * cookies, so routing it through requireAdmin would fail every request.
 */

const log = require('./logger').make('cors');

const METHODS = 'GET,POST,PATCH,DELETE,OPTIONS';
const HEADERS = 'Content-Type,X-Device-Id,Accept,Authorization';
const MAX_AGE = '600';

let warned = false;

/** Exact origins from ALLOWED_ORIGINS — scheme + host + port, no trailing slash. */
function allowedOrigins() {
  const raw = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  for (const origin of raw) {
    if (!/^https?:\/\/[^/\s]+$/i.test(origin) && !warned) {
      warned = true;
      log.warn(`ALLOWED_ORIGINS entry "${origin}" is not an origin like https://app.example.com — ignored`);
    }
  }
  return raw.filter(origin => /^https?:\/\/[^/\s]+$/i.test(origin));
}

function originOf(req) {
  return String(req.headers.origin || '').replace(/\/+$/, '');
}

/** The request's own origin, so a same-origin call is never treated as cross-origin. */
function sameOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  return host ? `${String(proto).split(',')[0]}://${String(host).split(',')[0]}`.replace(/\/+$/, '') : '';
}

/** The hostname of an origin, lowercased and without IPv6 brackets. */
function hostOf(origin) {
  try {
    return new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/** A hostname only this machine can answer on: a browser sends a loopback
 * Origin only from a page it loaded from this machine. */
function isLoopback(host) {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * True when the page and the service are both on loopback — the app's console,
 * a dev server, any local UI on any port. Same machine, so not cross-site.
 */
function isLocalPair(req) {
  const own = sameOrigin(req);
  const origin = originOf(req);
  if (!own || !origin) return false;
  return isLoopback(hostOf(origin)) && isLoopback(hostOf(own));
}

/**
 * True when this request comes from an origin allowed to read our answers.
 *
 * A loopback pair is allowed — and it is allowed by *sending the CORS headers*,
 * which is the part that is easy to get wrong. "Same machine" is a fact about
 * the request; CORS is a fact about the browser's origins, and the browser
 * compares scheme+host+port. A page on 127.0.0.1:5173 calling an API on
 * 127.0.0.1:8088 is a cross-origin request with everything that implies: no
 * Access-Control-Allow-Origin, and the browser discards the response no matter
 * how local it was. So the exemption suppresses the *refusal*, never the
 * headers. (It does mean an allowlist is not needed for a local dev server — a
 * local page was served by software running on this machine either way.)
 */
function isAllowedCrossSite(req) {
  const origin = originOf(req);
  if (!origin) return false;
  if (origin === sameOrigin(req)) return false;
  if (isLocalPair(req)) return true;
  return allowedOrigins().includes(origin);
}

/**
 * True only for a request that arrives from a *different* site: browsers send
 * Origin on every POST, including same-origin ones, so an allowlist must never
 * be read as "this server's own address is not allowed". A page served by this
 * server (the print site, the admin console) therefore always passes.
 */
function isForeignCrossSite(req) {
  const origin = originOf(req);
  if (!origin) return false;
  if (isLocalPair(req)) return false;
  return origin !== sameOrigin(req);
}

function middleware() {
  return (req, res, next) => {
    // Only the API is ever called cross-origin; static assets keep a clean,
    // cacheable response with no CORS headers and no Vary.
    if (!req.path.startsWith('/api/')) return next();

    const origin = originOf(req);
    res.setHeader('Vary', 'Origin');

    if (isAllowedCrossSite(req)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', METHODS);
      res.setHeader('Access-Control-Allow-Headers', HEADERS);
      res.setHeader('Access-Control-Max-Age', MAX_AGE);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      /* SameSite=None is only for a genuinely different site. A loopback pair is
       * one site on two ports, so its cookie can — and should — stay Strict. */
      if (!isLocalPair(req)) req.crossSite = true;

      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    } else if (req.method === 'OPTIONS') {
      // Unknown origin: answer the preflight without CORS headers, so the
      // browser blocks the real request for us.
      res.status(204).end();
      return;
    } else if (isForeignCrossSite(req) && allowedOrigins().length) {
      log.warn(`refused a cross-site API request from ${origin} — not in ALLOWED_ORIGINS`);
      res.status(403).json({ error: 'This origin is not allowed to use this print server', origin });
      return;
    }

    next();
  };
}

module.exports = { middleware, allowedOrigins, isAllowedCrossSite, isForeignCrossSite, isLocalPair, sameOrigin };
