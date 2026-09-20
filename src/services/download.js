'use strict';
/* Which installer a licence comes with.
 *
 * The three apps are built on the shop's machine and published as GitHub
 * release assets. They are 85–100 MB each — far too large for the website
 * bundle — and a download link that 404s is worse than no link at all, so
 * every URL is built from the version in package.json and the repository the
 * release was published to. What a licence gets is decided by the *category on
 * the plan*, never by anything the browser sends.
 *
 *   RELEASES_REPO   the GitHub repository, default Aadrit1234/printbridge
 *   RELEASES_BASE   serve the files from somewhere else (your own mirror)
 *
 * Publish a release with the same tag the version implies (v3.1.0) and the
 * links below go live:
 *
 *   gh release create v3.1.0 release/*.exe --title "PrintBridge 3.1.0"
 */

const VERSION = require('../../package.json').version;

const APPS = {
  workspace: {
    id: 'workspace',
    label: 'PrintBridge Workspace',
    file: `PrintBridge-Workspace-Setup-${VERSION}.exe`,
    note: 'The machine app. It runs the print service on the computer the printer is plugged into, sets the printer up, and holds the console.',
  },
  shop: {
    id: 'shop',
    label: 'PrintBridge Shop',
    file: `PrintBridge-Shop-Setup-${VERSION}.exe`,
    note: "The owner's app. It connects to your machine over the network and carries the business half: pricing, expenses and reports.",
  },
  client: {
    id: 'client',
    label: 'PrintBridge Client',
    file: `PrintBridge-Client-Setup-${VERSION}.exe`,
    note: 'The customer app, for the people who print at your counter — it finds the machine and opens its print page. Optional: the same page works in any browser from the QR code.',
  },
};

function base() {
  const override = String(process.env.RELEASES_BASE || '').trim();
  if (override) return override.replace(/\/+$/, '');
  const repo = String(process.env.RELEASES_REPO || 'Aadrit1234/printbridge').trim();
  return `https://github.com/${repo}/releases/download/v${VERSION}`;
}

function view(app) {
  if (!app) return null;
  return { id: app.id, label: app.label, file: app.file, note: app.note, version: VERSION, url: `${base()}/${app.file}` };
}

/** The app a licence category gets, plus the customer app everybody can have. */
function forCategory(category) {
  const primary = APPS[category] || APPS.workspace;
  return {
    version: VERSION,
    primary: view(primary),
    also: category === 'client' ? [] : [view(APPS.client)],
  };
}

function all() { return Object.values(APPS).map(view); }

module.exports = { forCategory, all, view, VERSION };
