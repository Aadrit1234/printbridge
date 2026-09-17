'use strict';
/* Watchdog — keeps the printer picture fresh and the server self-managing.
 *
 *  • polls the active backend so every page shows live printer state
 *  • on Windows, auto-selects the HP Neverstop queue the first time it sees one
 *  • optional keep-alive pings (network printers drop off Wi-Fi when idle)
 *  • finishes jobs that were left waiting for a printer that was off or asleep
 *  • periodic retention cleanup so the data directory never grows forever */

const config = require('../config');
const storage = require('../storage');
const bus = require('../events');
const log = require('../logger').make('watchdog');
const registry = require('./backends/registry');
const queue = require('./queue');
const windows = require('./tools/windows');

const POLL_MS = 15000;
const CLEANUP_MS = 30 * 60 * 1000;

let pollTimer = null;
let cleanupTimer = null;
let keepAliveTimer = null;
let lastPrinterJson = '';
let lastPrinterStatus = null;

async function refreshPrinter({ silent = true } = {}) {
  try {
    const snapshot = await registry.state({ fresh: true });
    const json = JSON.stringify(snapshot);
    if (json !== lastPrinterJson) {
      lastPrinterJson = json;
      bus.emit('printer', snapshot);
      if (!silent) log.info(`printer: ${snapshot.active.id} / ${snapshot.state.status} — ${snapshot.state.detail}`);
    }

    // A printer that just came back should not make waiting jobs sit out their
    // backoff — send them immediately. Otherwise, pick up any whose timer is due
    // (covers a restart, or a backoff that outlived its process).
    const status = snapshot.state.status;
    if (status === 'ready' && lastPrinterStatus && lastPrinterStatus !== 'ready') {
      const retried = queue.wakeWaiters();
      if (retried) log.info(`printer is reachable again — retrying ${retried} waiting job(s) now`);
    }
    lastPrinterStatus = status;
    queue.pumpWaiting().catch(() => 0);

    return snapshot;
  } catch (e) {
    log.debug(`printer poll failed: ${e.message}`);
    return null;
  }
}

/** First-run convenience: pick the Neverstop's Windows queue automatically. */
async function autoProvision() {
  if (process.platform !== 'win32') return;
  if (config.get('backend') !== 'auto') return;
  if (config.get('spoolerQueue')) return;

  try {
    const queues = await windows.listQueues();
    if (!queues.length) return;
    const best = queues[0];
    const score = windows.scoreQueue(best);
    // Neverstop-style (100+) or any HP-ish queue (USB/HP bonuses) is safe to adopt.
    if (score < 40) {
      log.info(`no HP-style queue found yet (${queues.length} queue(s) available)`);
      return;
    }
    config.patch({ spoolerQueue: best.name });
    registry.invalidate();
    log.info(`auto-selected print queue "${best.name}" (${best.port || best.driver})`);
    bus.emit('log', { at: new Date().toISOString(), level: 'info', scope: 'watchdog', message: `Auto-selected printer queue "${best.name}"` });
  } catch (e) {
    log.debug(`auto-provision failed: ${e.message}`);
  }
}

function scheduleKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
  const minutes = config.get('keepAliveMinutes');
  if (!minutes || !config.get('printerUrl')) return;
  keepAliveTimer = setInterval(() => {
    registry.state({ fresh: true }).catch(() => {});
  }, minutes * 60000);
  log.info(`keep-alive enabled every ${minutes} min`);
}

function start() {
  queue.reconcile();

  refreshPrinter({ silent: false }).catch(() => {});
  autoProvision().then(() => refreshPrinter({ silent: false })).catch(() => {});

  pollTimer = setInterval(() => {
    refreshPrinter().catch(() => {});
  }, POLL_MS);

  cleanupTimer = setInterval(() => {
    storage.cleanup({ retentionHours: config.get('retentionHours'), maxJobs: 200 }).catch(() => {});
  }, CLEANUP_MS);

  scheduleKeepAlive();

  config.on('change', () => {
    registry.invalidate();
    scheduleKeepAlive();
    refreshPrinter().catch(() => {});
  });

  if (pollTimer.unref) pollTimer.unref();
  if (cleanupTimer.unref) cleanupTimer.unref();
  if (keepAliveTimer && keepAliveTimer.unref) keepAliveTimer.unref();

  log.info('watchdog started');
}

function stop() {
  clearInterval(pollTimer);
  clearInterval(cleanupTimer);
  clearInterval(keepAliveTimer);
}

module.exports = { start, stop, refreshPrinter, autoProvision };
