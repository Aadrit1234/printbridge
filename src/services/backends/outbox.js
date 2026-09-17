'use strict';
/* Outbox backend — the always-available fallback.
 *
 * When no printer is attached (or the spooler tools are missing) jobs still
 * complete: the exact print-ready PDF is written to data/outbox so the user can
 * see, download, or hand it to a printer later. It also makes the whole
 * pipeline observable in testing. */

const fsp = require('fs').promises;
const path = require('path');
const storage = require('../../storage');

function stamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeName(name) {
  return String(name || 'document')
    .replace(/\.[a-z0-9]{1,6}$/i, '')
    .replace(/[^\w.\- ()\u00C0-\u024F]/g, '_')
    .slice(0, 60) || 'document';
}

module.exports = {
  id: 'outbox',
  label: 'Outbox (save files, no printer)',
  kind: 'local',

  async available() { return true; },

  async state() {
    return {
      backend: 'outbox',
      status: 'ready',
      name: 'Outbox',
      detail: 'No printer attached — print-ready files are saved to data/outbox',
      queueDepth: 0,
      markers: [],
    };
  },

  async print({ job, filePath }) {
    const filename = `${stamp()}-${safeName(job.name)}.pdf`;
    const dest = path.join(storage.dirs.outbox, filename);
    await fsp.copyFile(filePath, dest);
    await new Promise(r => setTimeout(r, 900)); // brief pause so the UI shows the "printing" phase
    return {
      accepted: true,
      printerJobId: null,
      message: `Saved to outbox/${filename}`,
      artifacts: [dest],
    };
  },
};
