'use strict';
/* Cookie helpers.
 *
 * Three things now hold a session — the machine PIN, an owner account, and the
 * operator key — and all three need the same two decisions made correctly:
 * whether the cookie must travel cross-site (a static host calling this
 * backend), and whether it may be Secure. Getting that wrong per-caller is how
 * sessions leak, so it lives here once.
 */

/** Parse a Cookie header into a plain object. Never throws on junk. */
function parse(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    const value = part.slice(i + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

function isSecure(req) {
  if (!req) return false;
  if (req.secure) return true;
  return String(req.headers['x-forwarded-proto'] || '').includes('https');
}

/**
 * A session cookie's Set-Cookie value.
 *
 * Strict same-site is the default and the safe one. When the console is hosted
 * on another allowlisted origin the cookie has to travel cross-site, and
 * browsers only accept that with SameSite=None; Secure — a deliberate,
 * configured trade-off, never an accident.
 */
function build(name, value, { req = null, days = 0 } = {}) {
  const crossSite = Boolean(req && req.crossSite);
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly'];
  parts.push(crossSite ? 'SameSite=None' : 'SameSite=Strict');
  parts.push(`Max-Age=${days > 0 ? Math.round(days * 86400) : 0}`);
  if (isSecure(req) || crossSite) parts.push('Secure');
  return parts.join('; ');
}

/** The Set-Cookie value that drops a session. */
function clear(name, req = null) {
  return build(name, '', { req });
}

module.exports = { parse, build, clear, isSecure };
