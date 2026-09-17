'use strict';
/* IPP backend — network printers (including the Neverstop once it is moved to
 * Wi-Fi). Uses the same protocol AirPrint speaks, so PDF is sent natively. */

const ipp = require('ipp');
const config = require('../../config');
const log = require('../../logger').make('ipp');

const HOSTISH = /^[a-z0-9][a-z0-9._-]*(:\d+)?(\/.*)?$/i;

/* The bundled ipp package ships an attribute table from an old IANA snapshot
 * and throws a *string* for any name it does not know. "print-scaling" is a
 * normal IPP Everywhere job attribute it never heard of, which made every job
 * that used the default "fit to page" fail before a single byte left the host.
 * Register it once, with the same syntax as the neighbouring keyword attrs. */
(function registerPrintScaling() {
  try {
    const table = require('ipp/lib/attributes')['Job Template'];
    if (table && !table['print-scaling']) table['print-scaling'] = { ...table['print-color-mode'] };
  } catch (e) {
    log.debug(`could not extend the IPP attribute table: ${e.message}`);
  }
})();

// Job attributes a tough printer may refuse; the retry drops them.
const OPTIONAL_JOB_ATTRS = ['print-scaling', 'print-quality', 'print-color-mode', 'sides'];

/**
 * Turn whatever the user typed into a real IPP endpoint. People paste "the
 * printer's IP" far more often than a full URL, and both should just work:
 *   192.168.1.50            → ipp://192.168.1.50:631/ipp/print
 *   hp-neverstop.local      → ipp://hp-neverstop.local:631/ipp/print
 *   https://10.0.0.9/ipp/print → ipps://10.0.0.9:631/ipp/print
 */
function endpoint(configured) {
  const raw = String(configured === undefined ? config.get('printerUrl') : configured || '').trim();
  if (!raw) return null;

  let url = raw;
  if (/^https:\/\//i.test(url)) url = `ipps://${url.slice(8)}`;
  else if (/^http:\/\//i.test(url)) url = `ipp://${url.slice(7)}`;
  else if (!/^ipp(s)?:\/\//i.test(url)) {
    if (!HOSTISH.test(url)) return null;
    url = `ipp://${url}`;
  }

  const secure = /^ipps:/i.test(url);
  const rest = url.replace(/^ipp(s)?:\/\//i, '');
  const slash = rest.indexOf('/');
  let host = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);
  if (!host.includes(':')) host = `${host}:631`;
  return `${secure ? 'ipps' : 'ipp'}://${host}${path || '/ipp/print'}`;
}

function execute(url, operation, msg, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`Printer did not respond within ${timeoutMs / 1000}s — is it on and on the same network?`)); }
    }, timeoutMs);
    try {
      const printer = new ipp.Printer(url);
      printer.execute(operation, msg, (err, res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(res || {});
      });
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); }
    }
  });
}

/** Wrapper the browser needs: ipp:// is transport-mapped to http for the lib. */
function baseMsg(extra = {}) {
  return {
    'operation-attributes-tag': {
      'requesting-user-name': 'PrintBridge',
      'document-format': 'application/octet-stream',
      ...extra,
    },
  };
}

/** IPP answers put each attribute in its own group; single values are scalars. */
function responsePrinterAttrs(res) {
  return (res && res['printer-attributes-tag']) || res || {};
}

function responseJobAttrs(res) {
  return (res && res['job-attributes-tag']) || {};
}

function asList(value) {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? value : [value];
}

async function getAttrs(url, timeoutMs = 6000) {
  const res = await execute(url, 'Get-Printer-Attributes', baseMsg(), timeoutMs);
  const attrs = responsePrinterAttrs(res);
  const reasons = asList(attrs['printer-state-reasons']) || [];
  return {
    name: attrs['printer-name'] || null,
    model: attrs['printer-make-and-model'] || null,
    state: attrs['printer-state'] || null,        // idle | processing | stopped
    stateReasons: reasons.filter(r => r !== 'none'),
    stateMessage: attrs['printer-state-message'] || null,
    markerLevels: asList(attrs['marker-levels']),
    markerNames: asList(attrs['marker-names']),
    queuedJobs: attrs['queued-job-count'] ?? null,
    mediaDefault: attrs['media-default'] || null,
  };
}

function jobMessage(job, data, jobAttrs) {
  return {
    'operation-attributes-tag': {
      'requesting-user-name': 'PrintBridge',
      'job-name': String(job.name).slice(0, 120),
      'document-format': 'application/pdf',
    },
    'job-attributes-tag': jobAttrs,
    data,
  };
}

/** One Print-Job; resolves only on an IPP "successful" status. */
async function submit(url, job, data, jobAttrs, timeoutMs = 25000) {
  const res = await execute(url, 'Print-Job', jobMessage(job, data, jobAttrs), timeoutMs);
  const code = String(res.statusCode || '');
  if (!code.startsWith('successful')) {
    const error = new Error(`Printer rejected the job (${code || 'unknown status'})`);
    error.ippStatus = code;
    throw error;
  }
  return res;
}

/** Did the printer turn down the options (as opposed to the document/transport)? */
function isOptionRefusal(error) {
  return /attributes-or-values-not-supported|bad-request|document-format-not-supported/i
    .test(String((error && error.ippStatus) || (error && error.message) || ''));
}

/**
 * Nudge a dozing Wi-Fi printer. Cheap Get-Printer-Attributes call: it either
 * answers (already awake) or wakes up while we are still talking to it. Failing
 * is normal and not an error — the job retry loop is what finishes the story.
 */
async function wake(timeoutMs = 5000) {
  const url = endpoint();
  if (!url) return { ok: false, error: 'No network printer configured' };
  const started = Date.now();
  try {
    const attrs = await getAttrs(url, timeoutMs);
    return { ok: true, url, name: attrs.name || attrs.model || url, state: attrs.state, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, url, error: e.message, ms: Date.now() - started };
  }
}

module.exports = {
  id: 'ipp',
  label: 'Network printer (IPP / AirPrint)',
  kind: 'network',

  async available() { return Boolean(endpoint()); },

  wake,
  endpoint,

  async state() {
    const url = endpoint();
    if (!url) return { backend: 'ipp', status: 'unconfigured', name: 'No network printer', detail: 'Add the printer IP in the connection settings', queueDepth: 0, markers: [] };
    try {
      const attrs = await getAttrs(url);
      const status = attrs.state === 'stopped' ? 'error'
        : attrs.state === 'processing' ? 'busy'
        : attrs.state === 'idle' ? 'ready' : 'unknown';
      const markers = (attrs.markerLevels || []).map((level, i) => ({
        name: (attrs.markerNames && attrs.markerNames[i]) || `Supply ${i + 1}`,
        level: typeof level === 'number' ? level : -1,
      }));
      return {
        backend: 'ipp',
        status,
        name: attrs.name || attrs.model || url,
        detail: (attrs.stateReasons.length ? attrs.stateReasons.join(', ') : attrs.stateMessage) || 'Ready',
        queueDepth: attrs.queuedJobs ?? 0,
        markers,
        url,
        model: attrs.model || null,
      };
    } catch (e) {
      return { backend: 'ipp', status: 'offline', name: 'Network printer', detail: e.message, queueDepth: 0, markers: [], url };
    }
  },

  async print({ job, filePath, options = {} }) {
    const url = endpoint();
    if (!url) throw new Error('No network printer configured');
    const fsp = require('fs').promises;
    const data = await fsp.readFile(filePath);
    const paper = config.paper(options.paper);

    const jobAttrs = {
      media: paper.ipp,
      sides: options.duplex ? 'two-sided-long-edge' : 'one-sided',
      'print-color-mode': 'monochrome',
      'print-quality': options.quality === 'draft' ? 'draft' : 'normal',
    };
    if (options.copies > 1) jobAttrs.copies = options.copies;
    if (options.scale === 'fit') jobAttrs['print-scaling'] = 'fit';

    let res;
    let basicOnly = false;
    try {
      res = await submit(url, job, data, jobAttrs);
    } catch (e) {
      const extra = Object.keys(jobAttrs).filter(name => OPTIONAL_JOB_ATTRS.includes(name));
      if (!extra.length || !isOptionRefusal(e)) throw e;
      // Older/mono printers reject the richer job attributes instead of ignoring
      // them. Print the document with the essentials rather than nothing.
      log.warn(`${url} refused ${extra.join(', ')} (${e.message}) — retrying with basic options`);
      basicOnly = true;
      const essentials = { media: jobAttrs.media };
      if (jobAttrs.copies) essentials.copies = jobAttrs.copies;
      res = await submit(url, job, data, essentials);
    }

    const jobGroup = responseJobAttrs(res);
    const remoteJobId = jobGroup['job-id'] ?? res['job-id'] ?? null;
    log.info(`job ${job.id} accepted by ${url}${remoteJobId ? ` as #${remoteJobId}` : ''}${basicOnly ? ' (basic options)' : ''}`);
    return {
      accepted: true,
      printerJobId: remoteJobId === null ? null : String(remoteJobId),
      message: `Accepted by printer${options.copies > 1 ? ` (${options.copies} copies)` : ''}${basicOnly ? ' · basic options only' : ''}`,
    };
  },

  async cancel(printerJobId) {
    const url = endpoint();
    if (!url || !printerJobId) return { ok: false };
    try {
      await execute(url, 'Cancel-Job', {
        'operation-attributes-tag': { 'requesting-user-name': 'PrintBridge', 'job-id': Number(printerJobId) },
      }, 6000);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },
};
