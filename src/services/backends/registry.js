'use strict';
/* Backend registry — decides where jobs actually go.
 *
 * Resolution order in "auto" mode:
 *   Windows spooler (USB driver queue) → IPP network printer → CUPS → outbox.
 * The chosen backend and the reason are always reported so the UI can explain
 * any fallback (e.g. "queue selected but the silent-print helper is missing"). */

const config = require('../../config');
const log = require('../../logger').make('registry');
const bus = require('../../events');
const windows = require('../tools/windows');
const { browseMdns, scanSubnets, localSubnets } = require('../discovery');

const spooler = require('./spooler');
const ipp = require('./ipp');
const cups = require('./cups');
const outbox = require('./outbox');

const BACKENDS = { spooler, ipp, cups, outbox };
const ORDER = ['spooler', 'ipp', 'cups', 'outbox'];

let cache = null; // { at, state }
const CACHE_MS = 4000;

async function resolve() {
  const requested = config.get('backend');
  const tried = [];

  if (requested !== 'auto') {
    const backend = BACKENDS[requested];
    if (!backend) return { backend: outbox, id: 'outbox', reason: `Unknown backend "${requested}" — using outbox` };
    const ok = await backend.available().catch(() => false);
    if (!ok) {
      log.warn(`backend "${requested}" is unavailable — falling back to outbox`);
      return { backend: outbox, id: 'outbox', requested, reason: `${backend.label} is not available right now` };
    }
    return { backend, id: requested, requested, reason: `Pinned to ${backend.label}` };
  }

  for (const id of ORDER) {
    const backend = BACKENDS[id];
    let ok = false;
    try { ok = await backend.available(); } catch (e) { tried.push(`${id}: ${e.message}`); }
    if (ok) return { backend, id, requested: 'auto', reason: describeChoice(id) };
    tried.push(`${id}: not available`);
  }
  return { backend: outbox, id: 'outbox', requested: 'auto', reason: 'No printer available — jobs are saved to the outbox' };
}

function describeChoice(id) {
  switch (id) {
    case 'spooler': return config.get('spoolerQueue')
      ? `Using the Windows print queue "${config.get('spoolerQueue')}" (USB)`
      : 'Using the Windows print queue';
    case 'ipp': return `Using the network printer at ${ipp.endpoint() || config.get('printerUrl')}`;
    case 'cups': return `Using CUPS queue "${config.get('cupsQueue')}"`;
    default: return 'Using the outbox';
  }
}

async function state({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.state;
  const resolved = await resolve();
  let backendState;
  try {
    backendState = await resolved.backend.state();
  } catch (e) {
    backendState = { backend: resolved.id, status: 'error', name: resolved.backend.label, detail: e.message, queueDepth: 0, markers: [] };
  }
  const snapshot = {
    platform: process.platform,
    requested: resolved.requested,
    active: { id: resolved.id, label: resolved.backend.label, kind: resolved.backend.kind },
    reason: resolved.reason,
    state: backendState,
    at: new Date().toISOString(),
  };
  cache = { at: Date.now(), state: snapshot };
  return snapshot;
}

function invalidate() { cache = null; bus.emit('printerInvalidated', {}); }

async function print({ job, filePath, options, onPhase = () => {} }) {
  const resolved = await resolve();

  // A Wi-Fi printer that has been idle for a while is usually asleep; a short
  // ping has it awake and ready by the time the document arrives.
  if (resolved.backend.kind === 'network' && typeof resolved.backend.wake === 'function') {
    onPhase('Waking the printer…');
    const woke = await resolved.backend.wake().catch(e => ({ ok: false, error: e.message }));
    if (woke.ok) log.debug(`printer awake (${woke.ms}ms)`);
    else log.warn(`printer did not answer the wake-up call: ${woke.error}`);
  }

  onPhase(`Submitting to ${resolved.backend.label}…`);
  const result = await resolved.backend.print({ job, filePath, options });
  log.info(`job ${job.id} → ${resolved.id}: ${result.message}`);
  return { ...result, backend: resolved.id };
}

/** Manual wake-up call, used by Admin → Printer when the printer looks asleep. */
async function wake() {
  const resolved = await resolve();
  if (typeof resolved.backend.wake !== 'function') {
    return { ok: false, backend: resolved.id, error: `${resolved.backend.label} has no wake-up call — check its own power setting` };
  }
  const result = await resolved.backend.wake();
  return { ...result, backend: resolved.id };
}

async function cancel(job) {
  const resolved = await resolve();
  if (typeof resolved.backend.cancel !== 'function') return { ok: false };
  return resolved.backend.cancel(job.printerJobId);
}

/** Everything the connection UI needs: local queues, CUPS queues, mDNS hits. */
async function locate({ mdns = true, scan = false, timeoutMs = 9000 } = {}) {
  const [win, unix, network] = await Promise.all([
    windows.listQueues().catch(() => []),
    cups.available().then(ok => (ok ? cups.enumerate().catch(() => []) : [])).catch(() => []),
    (async () => {
      const found = [];
      if (mdns) found.push(...await browseMdns(timeoutMs).catch(() => []));
      if (scan) {
        const subnets = localSubnets();
        const scanned = await scanSubnets(subnets, { timeoutMs: 260, concurrency: 48 }).catch(() => []);
        found.push(...scanned);
      }
      return dedupe(found);
    })(),
  ]);

  return {
    windowsQueues: win,
    cupsQueues: unix,
    networkPrinters: network,
    subnets: localSubnets(),
  };
}

function dedupe(list) {
  const seen = new Map();
  for (const item of list) {
    const key = (item.host || item.url || item.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.set(key, item);
  }
  return [...seen.values()];
}

async function diagnostics() {
  const tools = await windows.toolsStatus().catch(() => ({ sumatra: null, adobe: null, winget: null, ready: false }));
  const resolved = await resolve();
  let office = false;
  try { office = await require('../render').hasOfficeSupport(); } catch { /* optional */ }
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    activeBackend: { id: resolved.id, requested: resolved.requested, reason: resolved.reason },
    tools: {
      sumatra: tools.sumatra,
      adobe: tools.adobe,
      winget: tools.winget,
      silentPrintReady: tools.ready,
      libreoffice: office,
    },
    queues: {
      windows: config.get('spoolerQueue') || null,
      cups: config.get('cupsQueue') || null,
      ipp: config.get('printerUrl') || null,
    },
    subnets: localSubnets(),
    outbox: require('../../storage').dirs.outbox,
  };
}

module.exports = {
  BACKENDS, ORDER, resolve, state, print, cancel, wake, locate, diagnostics, invalidate,
};
