'use strict';
/* Leveled logger with a ring buffer so the UI can show live diagnostics. */

const bus = require('./events');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_SIZE = 400;

const ring = [];
let minLevel = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function push(level, scope, message, extra) {
  if (LEVELS[level] < minLevel) return;
  const entry = {
    at: new Date().toISOString(),
    level,
    scope,
    message: String(message),
    extra: extra === undefined ? null : extra,
  };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  bus.emit('log', entry);

  const line = `[${level}] ${scope ? scope + ': ' : ''}${entry.message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function make(scope) {
  return {
    debug: (m, x) => push('debug', scope, m, x),
    info: (m, x) => push('info', scope, m, x),
    warn: (m, x) => push('warn', scope, m, x),
    error: (m, x) => push('error', scope, m, x),
  };
}

module.exports = {
  make,
  recent: (limit = 200) => ring.slice(-limit),
  setLevel(level) { if (LEVELS[level]) minLevel = LEVELS[level]; },
};
