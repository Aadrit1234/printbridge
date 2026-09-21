'use strict';
/* The printer machines this app knows about, and the one it is working with.
 *
 * The workspace app never needs this — it *is* the machine. The shop app and
 * the client app do: they are clients, so their first question is always "which
 * machine", and nobody should have to answer it twice or remember an IP.
 *
 *   <userData>/machines.json
 *     current  the machine the console is pointed at (id)
 *     known    every machine this app has met: address, name, tier, last seen
 *
 * A machine is remembered by address, not by name, because the name is what a
 * human typed and the address is what actually answers.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 8088;
let file = null;
let state = { current: null, known: [] };

function init({ userData }) {
  file = path.join(userData, 'machines.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    state = {
      current: saved && saved.current ? String(saved.current) : null,
      known: Array.isArray(saved && saved.known) ? saved.known.map(clean).filter(Boolean) : [],
    };
  } catch {
    state = { current: null, known: [] };
  }
  return state;
}

/* ---------------- shape ---------------- */

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

/**
 * Accept what a human types, what mDNS reports, a full URL, or an id — an id
 * *is* `host:port` (see idFor), and the renderer sends nothing else when you
 * press "Use this" on a machine it just found. Reading only `host`/`port`/
 * `address`/`url` made that a silent no-op: the button did nothing, no error,
 * and the picker sat there saying nothing was chosen.
 */
function address(input) {
  const raw = typeof input === 'string' ? { address: input } : (input || {});
  let host = text(raw.host, 120);
  let port = Number(raw.port) || 0;

  const asUrl = text(raw.address || raw.url || raw.id, 300);
  if (asUrl) {
    const withScheme = /^https?:\/\//i.test(asUrl) ? asUrl : `http://${asUrl}`;
    try {
      const parsed = new URL(withScheme);
      host = parsed.hostname;
      port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : DEFAULT_PORT);
    } catch {
      return null;
    }
  }
  if (!host) return null;
  if (!port) port = DEFAULT_PORT;
  if (!/^[a-z0-9._-]+$/i.test(host)) return null;
  return { host, port };
}

function idFor({ host, port }) {
  return `${host}:${port}`;
}

function clean(machine) {
  const addr = address(machine);
  if (!addr) return null;
  return {
    id: idFor(addr),
    host: addr.host,
    port: addr.port,
    name: text(machine.name, 80) || `${addr.host}:${addr.port}`,
    tier: text(machine.tier, 20) || '',
    version: text(machine.version, 40) || '',
    source: machine.source === 'mdns' ? 'mdns' : 'manual',
    addedAt: text(machine.addedAt, 40) || new Date().toISOString(),
    lastSeen: text(machine.lastSeen, 40) || null,
  };
}

/* ---------------- persistence ---------------- */

function save() {
  if (!file) return false;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- api ---------------- */

function list() {
  return state.known.slice().sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
}

function find(idOrAddress) {
  const key = text(idOrAddress, 300);
  if (!key) return null;
  const direct = state.known.find(m => m.id === key);
  if (direct) return direct;
  const addr = address(key);
  return addr ? state.known.find(m => m.id === idFor(addr)) || null : null;
}

/** Remember a machine (by address), or update what we know about one. */
function remember(input, extra = {}) {
  const entry = clean({ ...(typeof input === 'string' ? { address: input } : input), ...extra });
  if (!entry) return null;
  const existing = state.known.find(m => m.id === entry.id);
  if (existing) {
    /* Only a real name may replace the one we have. `clean` fills a missing name
     * in with the address, so a call that knows nothing about the machine would
     * otherwise rename it to its own address. */
    const betterName = entry.name && entry.name !== entry.id ? entry.name : '';
    existing.name = betterName || existing.name;
    existing.tier = entry.tier || existing.tier;
    existing.version = entry.version || existing.version;
    existing.source = existing.source === 'manual' ? 'manual' : entry.source;
    existing.lastSeen = entry.lastSeen || existing.lastSeen;
  } else {
    state.known.push(entry);
  }
  save();
  return existing || entry;
}

function current() {
  return state.current ? find(state.current) : null;
}

function use(idOrAddress) {
  const machine = remember(idOrAddress, { lastSeen: new Date().toISOString() });
  if (!machine) return null;
  state.current = machine.id;
  save();
  return machine;
}

function forget(idOrAddress) {
  const machine = find(idOrAddress);
  if (!machine) return false;
  state.known = state.known.filter(m => m.id !== machine.id);
  if (state.current === machine.id) state.current = null;
  save();
  return true;
}

/** What the renderer and the host need to reach the current machine. */
function target() {
  const machine = current();
  if (!machine) return null;
  return { host: machine.host, port: machine.port };
}

module.exports = { init, address, idFor, list, find, remember, current, use, forget, target, DEFAULT_PORT };
