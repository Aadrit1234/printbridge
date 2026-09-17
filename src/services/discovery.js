'use strict';
/* Printer discovery: mDNS (fast, finds IPP/AirPrint devices) and an optional
 * subnet port scan for printers that do not advertise. */

const net = require('net');
const os = require('os');
const log = require('../logger').make('discovery');

function browseMdns(timeoutMs = 8000) {
  return new Promise((resolve) => {
    let bonjour;
    try {
      const mod = require('bonjour-service');
      const Bonjour = mod.default || mod.Bonjour;
      bonjour = new Bonjour();
    } catch (e) {
      log.warn('mDNS unavailable: ' + e.message);
      return resolve([]);
    }

    const found = new Map();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { bonjour.destroy(); } catch { /* noop */ }
      resolve([...found.values()]);
    };

    for (const type of ['ipp', 'ipps', 'printer', 'pdl-datastream']) {
      try {
        bonjour.find({ type }, (svc) => {
          if (!svc || !svc.addresses || !svc.addresses.length) return;
          const host = svc.addresses.find(a => a.includes('.') && !a.includes(':'));
          if (!host) return;
          const rp = (svc.txt && (svc.txt.rp || svc.txt.uri || svc.txt.URL)) || '';
          const path = rp && rp.startsWith('/') ? rp : '/ipp/print';
          const secure = type === 'ipps';
          const url = type === 'pdl-datastream' ? `socket://${host}:${svc.port || 9100}` : `${secure ? 'ipps' : 'ipp'}://${host}:${svc.port || 631}${path}`;
          if (found.has(url)) return;
          found.set(url, {
            name: (svc.txt && svc.txt.ty) || svc.name || host,
            host,
            port: svc.port || 631,
            url,
            via: 'mdns',
            kind: type === 'pdl-datastream' ? 'raw' : 'ipp',
          });
        });
      } catch (e) {
        log.debug(`mDNS type ${type} browse failed: ${e.message}`);
      }
    }
    setTimeout(finish, timeoutMs);
  });
}

function localSubnets() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) {
        const prefix = it.address.split('.').slice(0, 3).join('.') + '.';
        if (!out.includes(prefix)) out.push(prefix);
      }
    }
  }
  return out.slice(0, 2); // keep scans bounded
}

function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try { socket.connect(port, host); } catch { done(false); }
  });
}

/** Port-scan the local /24s for IPP (631) and JetDirect (9100) listeners. */
async function scanSubnets(prefixes, { timeoutMs = 260, concurrency = 48 } = {}) {
  const results = [];
  const jobs = [];
  for (const prefix of prefixes) {
    for (let i = 1; i <= 254; i++) jobs.push(`${prefix}${i}`);
  }
  let cursor = 0;
  const ports = [631, 9100];

  async function worker() {
    while (cursor < jobs.length) {
      const host = jobs[cursor++];
      for (const port of ports) {
        // eslint-disable-next-line no-await-in-loop
        const open = await probe(host, port, timeoutMs);
        if (open) {
          results.push(port === 631
            ? { name: `Printer at ${host}`, host, port, url: `ipp://${host}:631/ipp/print`, via: 'scan', kind: 'ipp' }
            : { name: `Raw printer at ${host}`, host, port, url: `socket://${host}:${port}`, via: 'scan', kind: 'raw' });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  if (results.length) log.info(`scan found ${results.length} candidate(s)`);
  return results;
}

module.exports = { browseMdns, scanSubnets, localSubnets };
