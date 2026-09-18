'use strict';
/* Backend registry — decides where jobs actually go.
 *
 * Two ways to pick a printer:
 *
 *   • the default path, resolved from the settings:
 *       Windows spooler (USB driver queue) → network printer → CUPS → outbox
 *     with the reason always reported, so the UI can explain a fallback;
 *   • a *target* — one explicit printer a person chose in the print sheet,
 *     e.g. "spooler:HP Neverstop" or "ipp:ipp://192.168.1.50:631/ipp/print".
 *
 * Targets are what the guest picker is built on. A job that names a target uses
 * exactly that printer; anything else follows the settings.
 */

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

let cache = null;        // { at, state }
let targetsCache = null; // { at, list }
let lastNetwork = [];    // printers seen by the last discovery, so the picker can offer them
let networkScannedAt = 0;
const CACHE_MS = 4000;
const TARGETS_MS = 15000;
const NETWORK_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Default resolution                                                  */
/* ------------------------------------------------------------------ */

async function resolve() {
  const requested = config.get('backend');
  const tried = [];

  if (requested !== 'auto') {
    const backend = BACKENDS[requested];
    if (!backend) return { backend: outbox, id: 'outbox', requested, reason: `Unknown print path "${requested}" — using the outbox` };
    const ok = await backend.available().catch(() => false);
    if (!ok) {
      log.warn(`print path "${requested}" is unavailable — falling back to the outbox`);
      return { backend: outbox, id: 'outbox', requested, reason: `${backend.label} is not available right now` };
    }
    return { backend, id: requested, requested, reason: `Pinned to ${backend.label}` };
  }

  for (const id of ORDER) {
    const backend = BACKENDS[id];
    let ok = false;
    try { ok = await backend.available(); } catch (e) { tried.push(`${id}: ${e.message}`); }
    if (ok) return { backend, id, requested: 'auto', reason: describeChoice(id), target: defaultTargetFor(id) };
    tried.push(`${id}: not available`);
  }
  return { backend: outbox, id: 'outbox', requested: 'auto', reason: 'No printer available — jobs are saved to the outbox', target: { id: 'outbox', kind: 'outbox' } };
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

/** The target the default path points at, so the picker can mark it. */
function defaultTargetFor(backendId) {
  if (backendId === 'spooler' && config.get('spoolerQueue')) {
    return { id: `spooler:${config.get('spoolerQueue')}`, kind: 'spooler', queue: config.get('spoolerQueue') };
  }
  if (backendId === 'ipp') {
    const url = ipp.endpoint();
    if (url) return { id: `ipp:${url}`, kind: 'ipp', url };
  }
  if (backendId === 'cups' && config.get('cupsQueue')) {
    return { id: `cups:${config.get('cupsQueue')}`, kind: 'cups', queue: config.get('cupsQueue') };
  }
  if (backendId === 'outbox') return { id: 'outbox', kind: 'outbox' };
  return null;
}

/* ------------------------------------------------------------------ */
/* Explicit targets                                                    */
/* ------------------------------------------------------------------ */

/** "spooler:HP Neverstop" → { kind, queue } */
function parseTarget(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw === 'outbox') return { id: 'outbox', kind: 'outbox' };

  const separator = raw.indexOf(':');
  const kind = separator === -1 ? 'ipp' : raw.slice(0, separator).toLowerCase();
  const rest = separator === -1 ? raw : raw.slice(separator + 1);

  if (kind === 'spooler' && rest) return { id: `spooler:${rest}`, kind: 'spooler', queue: rest };
  if (kind === 'cups' && rest) return { id: `cups:${rest}`, kind: 'cups', queue: rest };
  if (kind === 'ipp' && rest) {
    const url = ipp.endpoint(rest);
    if (url) return { id: `ipp:${url}`, kind: 'ipp', url };
  }
  return null;
}

/**
 * Resolve a chosen target to a backend, or explain why it is not usable.
 * Never silently swaps in a different printer — the person asked for *this* one.
 */
async function resolveTarget(value) {
  const target = parseTarget(value);
  if (!target) return null;

  const backend = BACKENDS[target.kind];
  if (!backend) return null;

  const usable = typeof backend.availableFor === 'function'
    ? await backend.availableFor(target.queue || target.url).catch(() => false)
    : await backend.available().catch(() => false);

  if (!usable) {
    return {
      backend: outbox, id: target.kind, requested: 'target', target,
      unavailable: true,
      reason: `${labelFor(target)} is not usable right now`,
    };
  }

  return { backend, id: target.kind, requested: 'target', target, reason: `Using ${labelFor(target)}` };
}

function labelFor(target, state) {
  if (!target) return 'the default printer';
  if (state && state.name) return state.name;
  if (target.kind === 'ipp') return target.url || 'the network printer';
  if (target.queue) return target.queue;
  return 'the outbox';
}

/* ------------------------------------------------------------------ */
/* What can be printed to                                              */
/* ------------------------------------------------------------------ */

/** Printers a person may choose from: engines on this machine, the network printer, outbox. */
async function targets({ fresh = false } = {}) {
  if (!fresh && targetsCache && Date.now() - targetsCache.at < TARGETS_MS) return targetsCache.list;

  const [queues, unixQueues, resolved, snapshot] = await Promise.all([
    windows.listQueues().catch(() => []),
    cups.available().then(ok => (ok ? cups.enumerate().catch(() => []) : [])).catch(() => []),
    resolve(),
    state().catch(() => null),
  ]);

  const list = [];
  const activeTarget = resolved.target ? resolved.target.id : null;

  for (const queue of queues) {
    // Virtual queues (Print to PDF, OneNote) are not printers; shipping a
    // document into one produces a file someone has to fetch. Leave them out.
    if (queue.score !== undefined && queue.score <= -100) continue;
    if (/print to pdf|onenote|xps document writer|fax/i.test(queue.name)) continue;
    list.push({
      id: `spooler:${queue.name}`,
      kind: queue.kind === 'usb' ? 'usb' : queue.kind === 'network' ? 'network' : 'local',
      name: queue.name,
      detail: [queue.kind ? queue.kind.toUpperCase() : null, queue.driver, queue.port].filter(Boolean).join(' · '),
      status: queue.status === 'ready' ? 'ready' : queue.status || 'unknown',
      recommended: Boolean(queue.recommended),
    });
  }

  for (const queue of unixQueues) {
    list.push({
      id: `cups:${queue.name}`,
      kind: 'local',
      name: queue.name,
      detail: 'CUPS',
      status: 'unknown',
      recommended: false,
    });
  }

  const configured = ipp.endpoint();
  if (configured) {
    list.push({
      id: `ipp:${configured}`,
      kind: 'network',
      name: ippTargetName(snapshot, configured),
      detail: configured.replace(/^ipps?:\/\//, ''),
      status: snapshot && snapshot.active.id === 'ipp' ? snapshot.state.status : 'unknown',
      recommended: resolved.id === 'ipp',
    });
  }

  for (const printer of lastNetwork) {
    if (printer.kind !== 'ipp' || !printer.url) continue;
    const normalized = ipp.endpoint(printer.url);
    if (!normalized || list.some(item => item.id === `ipp:${normalized}`)) continue;
    list.push({
      id: `ipp:${normalized}`,
      kind: 'network',
      name: printer.name || printer.host || 'Network printer',
      detail: normalized.replace(/^ipps?:\/\//, ''),
      status: 'unknown',
      recommended: false,
    });
  }

  list.push({
    id: 'outbox',
    kind: 'outbox',
    name: 'Outbox',
    detail: 'Keep the print-ready PDF on the server instead of printing',
    status: 'ready',
    recommended: list.length === 0,
  });

  const value = {
    printers: list,
    default: activeTarget,
    reason: resolved.reason,
    scannedAt: networkScannedAt || null,
  };
  targetsCache = { at: Date.now(), list: value };
  return value;
}

function ippTargetName(snapshot, url) {
  if (snapshot && snapshot.active && snapshot.active.id === 'ipp' && snapshot.state && snapshot.state.name) {
    const name = snapshot.state.name;
    if (name && !name.startsWith('ipp')) return name;
  }
  return 'Network printer';
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

async function state({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.state;
  const resolved = await resolve();
  let backendState;
  try {
    backendState = await resolved.backend.state(resolved.target ? resolved.target.queue : undefined);
  } catch (e) {
    backendState = { backend: resolved.id, status: 'error', name: resolved.backend.label, detail: e.message, queueDepth: 0, markers: [] };
  }
  const snapshot = {
    platform: process.platform,
    requested: resolved.requested,
    active: { id: resolved.id, label: resolved.backend.label, kind: resolved.backend.kind },
    target: resolved.target || null,
    reason: resolved.reason,
    state: backendState,
    at: new Date().toISOString(),
  };
  cache = { at: Date.now(), state: snapshot };
  return snapshot;
}

function invalidate() {
  cache = null;
  targetsCache = null;
  bus.emit('printerInvalidated', {});
}

/* ------------------------------------------------------------------ */
/* Printing                                                            */
/* ------------------------------------------------------------------ */

function argsFor(resolved) {
  const args = {};
  if (resolved.target && resolved.target.queue) args.queue = resolved.target.queue;
  if (resolved.target && resolved.target.url) args.printerUrl = resolved.target.url;
  return args;
}

async function print({ job, filePath, options = {}, onPhase = () => {} }) {
  const chosen = options.target || (job && job.target) || null;
  const resolved = (chosen ? await resolveTarget(chosen) : null) || (chosen ? null : await resolve());

  if (!resolved) {
    throw new Error(`The chosen printer is no longer available (${chosen})`);
  }
  if (resolved.unavailable) {
    throw new Error(`${resolved.reason} — pick another printer`);
  }

  const printOptions = { ...options, ...argsFor(resolved) };

  // A Wi-Fi printer that has been idle is usually asleep; a short ping has it
  // awake and ready by the time the document arrives.
  if (resolved.backend.kind === 'network' && typeof resolved.backend.wake === 'function') {
    onPhase('Waking the printer…');
    const woke = await resolved.backend.wake(5000, printOptions.printerUrl).catch(e => ({ ok: false, error: e.message }));
    if (woke.ok) log.debug(`printer awake (${woke.ms}ms)`);
    else log.warn(`printer did not answer the wake-up call: ${woke.error}`);
  }

  onPhase(`Submitting to ${resolved.backend.label}…`);
  const result = await resolved.backend.print({ job, filePath, options: printOptions });
  log.info(`job ${job.id} → ${resolved.id}${resolved.target ? ` (${resolved.target.id})` : ''}: ${result.message}`);
  return { ...result, backend: resolved.id, target: resolved.target ? resolved.target.id : null };
}

/** Manual wake-up call, used by Admin → Printer when the printer looks asleep. */
async function wake(target) {
  const resolved = target ? await resolveTarget(target) : await resolve();
  if (!resolved) return { ok: false, error: 'That printer is not known any more' };
  if (typeof resolved.backend.wake !== 'function') {
    return { ok: false, backend: resolved.id, error: `${resolved.backend.label} has no wake-up call — check its own power setting` };
  }
  const result = await resolved.backend.wake(5000, argsFor(resolved).printerUrl);
  return { ...result, backend: resolved.id };
}

async function cancel(job) {
  const resolved = job && job.target ? await resolveTarget(job.target) : await resolve();
  if (!resolved || typeof resolved.backend.cancel !== 'function') return { ok: false };
  return resolved.backend.cancel(job.printerJobId);
}

/* ------------------------------------------------------------------ */
/* Discovery & diagnostics                                             */
/* ------------------------------------------------------------------ */

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

  if (network.length) {
    lastNetwork = dedupe([...lastNetwork, ...network]).slice(0, 12);
    networkScannedAt = new Date().toISOString();
    targetsCache = null;
  }

  return {
    windowsQueues: win,
    cupsQueues: unix,
    networkPrinters: network.length ? network : lastNetwork,
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
    activeBackend: {
      id: resolved.id,
      requested: resolved.requested,
      reason: resolved.reason,
      target: resolved.target ? resolved.target.id : null,
    },
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
  BACKENDS, ORDER, resolve, resolveTarget, parseTarget, targets, state,
  print, cancel, wake, locate, diagnostics, invalidate,
};
