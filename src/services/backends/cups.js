'use strict';
/* CUPS backend for macOS / Linux hosts (lp + lpstat). */

const config = require('../../config');
const log = require('../../logger').make('cups');
const { runFile } = require('../tools/windows'); // runFile is platform-neutral

const isUnix = process.platform !== 'win32';

async function lpPath() {
  if (!isUnix) return null;
  const res = await runFile('which', ['lp'], { timeoutMs: 6000 });
  const hit = res.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
  return hit || null;
}

module.exports = {
  id: 'cups',
  label: 'System printer (CUPS)',
  kind: 'local',

  async available() {
    return Boolean(await lpPath());
  },

  async enumerate() {
    if (!isUnix) return [];
    const res = await runFile('lpstat', ['-p', '-d'], { timeoutMs: 8000 });
    return res.stdout.split(/\r?\n/)
      .map(l => l.match(/^printer (\S+)/i))
      .filter(Boolean)
      .map(m => ({ id: m[1], name: m[1], kind: 'local', driver: 'CUPS', port: '', status: 'unknown' }));
  },

  async state() {
    const queue = config.get('cupsQueue');
    if (!queue) return { backend: 'cups', status: 'unconfigured', name: 'No CUPS queue selected', detail: 'Choose a printer in the connection settings', queueDepth: 0, markers: [] };
    const res = await runFile('lpstat', ['-p', queue], { timeoutMs: 8000 });
    const text = `${res.stdout} ${res.stderr}`.toLowerCase();
    const status = /disabled/.test(text) ? 'error' : /printing/.test(text) ? 'busy' : /idle/.test(text) ? 'ready' : 'unknown';
    return { backend: 'cups', status, name: queue, detail: res.stdout.trim().split('\n')[0] || '', queueDepth: 0, markers: [] };
  },

  async print({ job, filePath, options = {} }) {
    const queue = config.get('cupsQueue');
    if (!queue) throw new Error('No CUPS queue selected');
    const lp = await lpPath();
    if (!lp) throw new Error('CUPS "lp" command not available');
    const paper = config.paper(options.paper);
    const args = ['-d', queue, '-n', String(Math.max(1, options.copies || 1)),
      '-o', `media=${paper.ipp}`, '-o', `sides=${options.duplex ? 'two-sided-long-edge' : 'one-sided'}`,
      '-o', options.scale === 'actual' ? 'noscale' : 'fit-to-page',
      '-t', String(job.name).slice(0, 80), filePath];
    const res = await runFile(lp, args, { timeoutMs: 120000 });
    if (res.code !== 0) throw new Error((res.stderr || res.stdout || 'lp failed').trim().slice(0, 200));
    log.info(`job ${job.id} submitted to ${queue}`);
    const idMatch = res.stdout.match(/request id is (\S+)/i);
    return { accepted: true, printerJobId: idMatch ? idMatch[1] : null, message: res.stdout.trim().slice(0, 120) || 'Submitted' };
  },

  async cancel(printerJobId) {
    if (!printerJobId) return { ok: false };
    const res = await runFile('cancel', [printerJobId], { timeoutMs: 10000 });
    return { ok: res.code === 0 };
  },
};
