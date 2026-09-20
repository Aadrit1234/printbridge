'use strict';
/* The app's log, in one place.
 *
 * Everything the app does that a person might need to explain later lands here:
 * the service's own output, the interface's errors, the network browse, the
 * sync. It is a ring buffer in memory plus one file on disk, and the console's
 * Setup panel tails it.
 *
 * This is separate from src/logger.js on purpose: this one lives in the app's
 * own user-data folder and can be written before (or without) the print service
 * ever starting — which is exactly when you most need it.
 */

const fs = require('fs');

const LIMIT = 900;
const lines = [];
let file = null;
let subscribers = new Set();

function init({ filePath }) {
  file = filePath || null;
  if (!file) return;
  try {
    const stat = fs.statSync(file);
    /* A log that grows forever is a disk-filling bug on a machine that runs for
     * months in a shop. Rotate once, at a size nobody will read past. */
    if (stat.size > 1024 * 1024) fs.renameSync(file, `${file}.1`);
  } catch { /* first run */ }
}

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function write(message) {
  const line = `${stamp()}  ${String(message).replace(/\s+$/, '')}`;
  lines.push(line);
  if (lines.length > LIMIT) lines.splice(0, lines.length - LIMIT);
  if (file) {
    try { fs.appendFileSync(file, line + '\n'); } catch { /* disk full, read-only… */ }
  }
  for (const fn of subscribers) {
    try { fn(line); } catch { /* a dead subscriber must not stop the log */ }
  }
  return line;
}

function tail(count = 400) {
  return lines.slice(-count);
}

function clear() {
  lines.length = 0;
}

function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function path() {
  return file;
}

module.exports = { init, write, tail, clear, subscribe, path, LIMIT };
