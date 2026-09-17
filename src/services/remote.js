'use strict';
/* Remote access — how this server is reached when you are *not* at home.
 *
 * PrintBridge itself is a plain HTTP server, so "print from anywhere" is a
 * networking question, not a software one. This module answers it honestly:
 *
 *   • which addresses can this machine be reached on right now (LAN, VPN)
 *   • is Tailscale installed, up, and does it expose a stable name
 *   • which URL should a phone on the road actually open
 *   • and, on request, does that URL really answer (self-probe)
 *
 * The recommended setup is a private mesh (Tailscale) rather than opening a
 * port: nothing is published to the internet, and only your own devices can
 * reach the printer.
 */

const os = require('os');
const https = require('https');
const http = require('http');
const config = require('../config');
const log = require('../logger').make('remote');
const { runFile } = require('./tools/windows');

const CACHE_MS = 15000;
const CGNAT = /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./; // 100.64.0.0/10 — Tailscale's range

let cache = null;
let tailscaleBinary = undefined; // undefined = not looked up yet

/* ---------------- local interfaces ---------------- */

function interfaces() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      out.push({
        name,
        address: it.address,
        cgnat: CGNAT.test(it.address),
        tailscale: CGNAT.test(it.address) || /tailscale/i.test(name),
      });
    }
  }
  return out;
}

function scoreAddress(entry) {
  const ip = entry.address;
  if (/^192\.168\./.test(ip)) return 3;
  if (/^10\./.test(ip)) return 2;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return 1;
  return 0;
}

function lanAddresses() {
  return interfaces().filter(i => !i.tailscale).sort((a, b) => scoreAddress(b) - scoreAddress(a));
}

/* ---------------- tailscale ---------------- */

/** Locate the CLI once; on Windows it installs outside PATH, so try the usual spot. */
async function findTailscale() {
  if (tailscaleBinary !== undefined) return tailscaleBinary || null;
  const candidates = process.platform === 'win32'
    ? ['tailscale.exe', 'C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe']
    : ['tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const res = await runFile(candidate, ['version'], { timeoutMs: 6000 }).catch(() => null);
    if (res && res.code === 0) { tailscaleBinary = candidate; return candidate; }
  }
  tailscaleBinary = '';
  return null;
}

/**
 * Ask the Tailscale daemon about this machine. Returns a shape the UI can show
 * even when the CLI is absent: the interface sniff still proves a tailnet link.
 */
async function tailscale() {
  const binary = await findTailscale();
  const info = {
    installed: Boolean(binary),
    binary: binary || null,
    up: false,
    state: 'not-installed',
    ip: null,
    dnsName: null,
    tailnet: null,
    httpsUrl: null,
    url: null,
    hints: [],
  };

  // A 100.x address is a tailnet link even without the CLI (e.g. on the router
  // side, or when the CLI is not on our PATH).
  const sniffed = interfaces().find(i => i.tailscale);

  if (binary) {
    const res = await runFile(binary, ['status', '--json'], { timeoutMs: 8000 }).catch(() => null);
    if (res && res.stdout) {
      try {
        const status = JSON.parse(res.stdout);
        const self = status.Self || {};
        const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
        info.ip = ips.find(ip => ip.includes('.')) || ips[0] || null;
        info.dnsName = String(self.DNSName || '').replace(/\.$/, '') || null;
        info.tailnet = (status.CurrentTailnet && status.CurrentTailnet.Name) || status.MagicDNSSuffix || null;
        info.state = status.BackendState || 'unknown';
        info.up = info.state === 'Running';
      } catch (e) {
        info.hints.push(`Could not read "tailscale status": ${e.message}`);
      }
    }
    if (!info.ip && sniffed) info.ip = sniffed.address;

    // `tailscale serve` gives a real HTTPS URL on the tailnet (valid cert, no
    // warning page) — worth surfacing when it is already configured.
    const serve = await runFile(binary, ['serve', 'status'], { timeoutMs: 8000 }).catch(() => null);
    const match = serve && /https:\/\/[^\s"']+/i.exec(serve.stdout || '');
    if (match) info.httpsUrl = match[0].replace(/\/$/, '');
  } else if (sniffed) {
    info.state = 'cli-not-found';
    info.up = true;
    info.ip = sniffed.address;
    info.hints.push('A Tailscale address is present on this machine, but the "tailscale" command was not found.');
  }

  if (info.up && !info.dnsName && info.ip) {
    info.hints.push('Sign in with "tailscale up" so this machine gets a stable name instead of a bare IP.');
  }

  info.url = info.httpsUrl || (info.dnsName ? `http://${info.dnsName}:${port()}` : null);
  return info;
}

function port() {
  return parseInt(process.env.PORT, 10) || 8088;
}

/* ---------------- effective remote URL ---------------- */

/** Config wins; otherwise use what the tailnet gives us. */
function effectiveUrl(ts) {
  const configured = config.get('remoteUrl');
  if (configured) return configured;
  return ts && ts.url ? ts.url : null;
}

/* ---------------- self-probe ---------------- */

function fetchStatus(url, timeoutMs = 7000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let parsed;
    try { parsed = new URL(url); } catch (e) { return done({ ok: false, error: `Not a valid URL: ${e.message}` }); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(`${url.replace(/\/$/, '')}/api/v1/system/meta`, { timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
      res.on('end', () => {
        let app = null;
        try { app = JSON.parse(body).appName || null; } catch { /* not our API */ }
        done({ ok: res.statusCode === 200, status: res.statusCode, app });
      });
    });
    req.on('timeout', () => { req.destroy(); done({ ok: false, error: `No answer within ${Math.round(timeoutMs / 1000)}s` }); });
    req.on('error', (e) => done({ ok: false, error: e.message }));
  });
}

/** Probe the URL a phone on the road would use — DNS, route and port all at once. */
async function verify(url) {
  const target = url || effectiveUrl(await snapshot({ fresh: true }).then(s => s.tailscale));
  if (!target) return { ok: false, error: 'No remote address to test yet' };
  const started = Date.now();
  const res = await fetchStatus(target);
  return { ...res, url: target, ms: Date.now() - started };
}

/* ---------------- snapshot ---------------- */

async function build() {
  const ts = await tailscale();
  const lan = lanAddresses().map(i => ({ name: i.name, address: i.address, url: `http://${i.address}:${port()}` }));
  const remoteUrl = config.get('remoteUrl') || '';
  const url = effectiveUrl(ts);

  const notes = [...ts.hints];
  if (!url) {
    notes.push('Nothing outside this network can reach PrintBridge yet — see Admin → Settings → Print from anywhere.');
  } else if (!remoteUrl && ts.url) {
    notes.push('Using the Tailscale name automatically. Set an address in Settings to override it.');
  }

  return {
    port: port(),
    lan,
    lanUrl: lan[0] ? lan[0].url : `http://localhost:${port()}`,
    tailscale: ts,
    remoteUrl,
    url,
    source: remoteUrl ? 'configured' : (ts.url ? 'tailscale' : null),
    notes,
    checkedAt: new Date().toISOString(),
  };
}

async function snapshot({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await build();
  cache = { at: Date.now(), value };
  return value;
}

function invalidate() { cache = null; }

/* ---------------- boot banner ---------------- */

/** One line for the startup banner, when a remote route exists. */
async function bannerLine() {
  try {
    const snap = await snapshot();
    if (!snap.url) return null;
    return { label: snap.source === 'configured' ? 'Anywhere' : 'Tailscale', url: snap.url };
  } catch (e) {
    log.debug(`remote banner skipped: ${e.message}`);
    return null;
  }
}

module.exports = { snapshot, verify, invalidate, bannerLine, interfaces, lanAddresses, port };
