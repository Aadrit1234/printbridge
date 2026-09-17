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
 * Anything not on the allowlist is left exactly as it was: no CORS headers, so
 * the browser refuses to let another site read the response. That is the whole
 * security story here, and it is why the allowlist is an explicit list of
 * origins rather than a wildcard.
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

/** True when this request comes from an allowlisted cross-site origin. */
function isAllowedCrossSite(req) {
  const origin = originOf(req);
  if (!origin) return false;
  if (origin === sameOrigin(req)) return false;
  return allowedOrigins().includes(origin);
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
      req.crossSite = true;

      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    } else if (req.method === 'OPTIONS') {
      // Unknown origin: answer the preflight without CORS headers, so the
      // browser blocks the real request for us.
      res.status(204).end();
      return;
    }

    next();
  };
}

module.exports = { middleware, allowedOrigins, isAllowedCrossSite, sameOrigin };
