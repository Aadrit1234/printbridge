'use strict';
/* Finding printer machines on this network.
 *
 * The server end of this is src/services/nearby.js, which announces a machine
 * as _printbridge._tcp. This is the other half: the browse that turns those
 * announcements into a list a person can click, so nobody types an address.
 *
 * Discovery is not authentication — anything on the network can see that a
 * machine is there. Talking to it still needs a print code or an account.
 */

const log = require('./log');

const SERVICE_TYPE = 'printbridge';
const DEFAULT_TIMEOUT = 2600;

function Bonjour() {
  const mod = require('bonjour-service');
  return mod.default || mod.Bonjour;
}

function localAddresses() {
  const os = require('os');
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it && it.family === 'IPv4') out.push(it.address);
    }
  }
  return out;
}

/**
 * Browse for machines. Resolves with what answered within the timeout — an
 * empty list is a normal answer, not an error (Wi-Fi can block multicast).
 */
function browse({ timeoutMs = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    let bonjour;
    try {
      bonjour = new (Bonjour())();
    } catch (error) {
      log(`could not browse the network: ${error.message}`);
      return resolve([]);
    }

    const found = new Map();
    const mine = new Set(localAddresses());
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { bonjour.destroy(); } catch { /* already gone */ }
      resolve([...found.values()]);
    };

    try {
      bonjour.find({ type: SERVICE_TYPE }, (service) => {
        if (!service) return;
        const addresses = (service.addresses || []).filter(a => a.includes('.') && !a.includes(':'));
        /* Prefer an address that is not this very machine, but keep it as a
         * fallback: on a one-PC install the machine *is* this machine. */
        const host = addresses.find(a => !mine.has(a)) || addresses[0] || service.host;
        if (!host) return;
        const key = `${host}:${service.port}`;
        if (found.has(key)) return;
        const txt = service.txt || {};
        found.set(key, {
          host,
          port: Number(service.port) || 8088,
          name: txt.name || service.name || host,
          tier: txt.tier || '',
          version: txt.app || '',
          path: txt.path || '/print/',
          local: mine.has(host),
          via: 'mdns',
          seenAt: new Date().toISOString(),
        });
      });
    } catch (error) {
      log(`browsing failed: ${error.message}`);
      return finish();
    }

    setTimeout(finish, Math.max(600, timeoutMs)).unref?.();
  });
}

/** Ask a host whether a PrintBridge service is actually answering there. */
async function confirm(host, port, { timeoutMs = 1500 } = {}) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: '/api/v1/system/meta', method: 'GET', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let payload = null;
          try { payload = JSON.parse(body); } catch { /* not ours */ }
          const ours = res.statusCode === 200 && payload && payload.app && payload.version;
          resolve(ours
            ? { ok: true, app: String(payload.app), version: String(payload.version), hostname: String(payload.hostname || '') }
            : { ok: false, reason: res.statusCode === 200 ? 'something else answers at that address' : `it answered ${res.statusCode}` });
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'nothing answered' }); });
    req.on('error', (error) => resolve({ ok: false, reason: error.code === 'ECONNREFUSED' ? 'nothing is listening there' : error.message }));
    req.end();
  });
}

module.exports = { browse, confirm, SERVICE_TYPE };
