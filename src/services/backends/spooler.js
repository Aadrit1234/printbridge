'use strict';
/* Windows spooler backend — this is what makes a USB-connected printer work.
 *
 * The HP Neverstop is a host-based device: only the Windows driver can render
 * for it, so jobs must go through the spooler queue. We drive SumatraPDF (rich
 * options, silent) or Adobe Reader (basic fallback) to submit the PDF. */

const fs = require('fs');
const config = require('../../config');
const log = require('../../logger').make('spooler');
const win = require('../tools/windows');

const isWindows = process.platform === 'win32';

/** Map our options onto SumatraPDF's -print-settings tokens. */
function sumatraSettings(options = {}) {
  const tokens = [];
  const copies = Math.max(1, Math.min(50, parseInt(options.copies, 10) || 1));
  tokens.push(`${copies}x`);
  tokens.push(options.duplex ? 'duplexlong' : 'simplex');
  tokens.push(`paper=${config.paper(options.paper).label}`);
  tokens.push(options.scale === 'actual' ? 'noscale' : 'shrink');
  if (options.range && String(options.range).trim()) tokens.push(String(options.range).replace(/\s+/g, ''));
  return tokens.join(',');
}

async function resolveEngine() {
  const sumatra = await win.findSumatra();
  if (sumatra) return { id: 'sumatra', path: sumatra };
  const adobe = await win.findAdobe();
  if (adobe) return { id: 'adobe', path: adobe };
  return null;
}

module.exports = {
  id: 'spooler',
  label: 'USB printer (Windows print queue)',
  kind: 'usb',

  /* Usable only when a queue has been chosen; otherwise the registry falls
   * back (outbox) so uploaded jobs still complete instead of failing. */
  async available() {
    if (!isWindows) return false;
    if (!config.get('spoolerQueue')) return false;
    return Boolean(await resolveEngine());
  },

  /**
   * Usable for one specific queue, when a job picked its own printer. The queue
   * itself has to exist: a target naming a queue this machine does not have is
   * refused up front instead of being queued against something that is gone.
   */
  async availableFor(queue) {
    if (!isWindows || !queue) return false;
    if (!await resolveEngine()) return false;
    const queues = await win.listQueues().catch(() => []);
    return queues.some(q => q.name.toLowerCase() === String(queue).toLowerCase());
  },

  async state(queueOverride) {
    const queue = queueOverride || config.get('spoolerQueue');
    const engine = await resolveEngine();

    if (!queue) {
      const queues = await win.listQueues().catch(() => []);
      return {
        backend: 'spooler', status: 'unconfigured',
        name: 'No queue selected',
        detail: queues.length
          ? `${queues.length} Windows print queue(s) found — pick yours in the connection settings`
          : 'No Windows print queue found — is the printer switched on and connected by USB?',
        queueDepth: 0, markers: [], engine: engine ? engine.id : null,
        candidates: queues.slice(0, 6).map(q => ({ name: q.name, kind: q.kind, driver: q.driver, port: q.port })),
      };
    }
    if (!engine) {
      return {
        backend: 'spooler', status: 'error', name: queue,
        detail: 'Silent print helper missing — install SumatraPDF so jobs can be submitted without a dialog',
        queueDepth: 0, markers: [], engine: null, needsEngine: true,
      };
    }
    try {
      const queues = await win.listQueues();
      const info = queues.find(q => q.name.toLowerCase() === queue.toLowerCase());
      if (!info) {
        return {
          backend: 'spooler', status: 'offline', name: queue,
          detail: 'Queue not found — the printer may be unplugged or renamed', queueDepth: 0, markers: [], engine: engine.id,
        };
      }
      const depth = await win.queueJobCount(info.name);
      const status = info.status === 'ready' ? (depth > 0 ? 'busy' : 'ready') : info.status;
      return {
        backend: 'spooler',
        status,
        name: info.name,
        detail: `${info.kind === 'usb' ? 'USB' : info.kind === 'network' ? 'Network' : 'Local'} · ${info.driver || info.port}`,
        queueDepth: depth || 0,
        markers: [],
        engine: engine.id,
        queue: info,
      };
    } catch (e) {
      return { backend: 'spooler', status: 'unknown', name: queue, detail: e.message, queueDepth: 0, markers: [], engine: engine.id };
    }
  },

  async enumerate() {
    if (!isWindows) return [];
    const queues = await win.listQueues();
    return queues.map((q, idx) => ({
      ...q,
      recommended: idx === 0 && win.scoreQueue(q) >= 100 && q.kind === 'usb',
    }));
  },

  async print({ job, filePath, options = {} }) {
    const queue = options.queue || config.get('spoolerQueue');
    if (!queue) throw new Error('No Windows print queue selected');
    const engine = await resolveEngine();
    if (!engine) throw new Error('No silent print engine available (install SumatraPDF or Adobe Reader)');
    if (!fs.existsSync(filePath)) throw new Error('Print file is missing');

    let args;
    if (engine.id === 'sumatra') {
      args = [
        '-print-to', queue,
        '-print-settings', sumatraSettings(options),
        '-silent',
        '-exit-when-done',
        filePath,
      ];
    } else {
      // Adobe is a fallback: paper/copies come from the driver defaults.
      args = ['/n', '/s', '/o', '/h', '/t', filePath, queue];
    }

    log.info(`submitting ${path_basename(filePath)} to "${queue}" via ${engine.id}`);
    const res = await win.runFile(engine.path, args, { timeoutMs: 240000 });

    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout || res.error || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
      throw new Error(`Print queue rejected the job (exit ${res.code})${detail ? ': ' + detail.slice(0, 200) : ''}`);
    }

    const depth = await win.queueJobCount(queue).catch(() => null);
    return {
      accepted: true,
      printerJobId: null,
      message: `Sent to "${queue}"${options.copies > 1 ? ` · ${options.copies} copies` : ''}${depth ? ` · ${depth} job(s) in queue` : ''}`,
    };
  },

  async cancel() {
    return { ok: false, reason: 'Windows queues must be cleared from the printer queue window' };
  },
};

function path_basename(p) { return String(p).split(/[\\/]/).pop(); }
