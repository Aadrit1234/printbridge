'use strict';
/* What makes one PrintBridge app different from another.
 *
 * There are three, and they are the same code with three jobs:
 *
 *   workspace  the machine's own app. It *is* the printer: it runs the print
 *              service, sets the printer up, and holds the console. Run it on
 *              the PC the printer is plugged into.
 *   shop       the owner's app. It is a *client*: it finds a machine on the
 *              network and manages it from across the counter, and it adds the
 *              business half a machine has no business knowing — prices,
 *              expenses, revenue.
 *   client     the customer's app. Also a client, but the other side of it: it
 *              finds a machine and prints, with no browser and no address typed.
 *
 * Everything else — the console, the API client, the session handling, the
 * theme, the views — is shared, because a second copy of the console would rot
 * within a release. A profile says which parts of that whole this app is.
 */

const ROLES = ['machine', 'console', 'client'];

const PANELS = {
  machine: ['queue', 'codes', 'printers', 'printer', 'settings', 'access', 'account'],
  business: ['pricing', 'expenses', 'reports'],
  machineOnly: ['setup'],
  connection: ['connection'],
};

/** Fill in the parts every app has, and refuse a profile that makes no sense. */
function normalize(profile) {
  const id = String(profile.id || '').trim();
  if (!id) throw new Error('a profile needs an id');
  const role = ROLES.includes(profile.role) ? profile.role : 'console';

  const panels = Array.isArray(profile.panels) && profile.panels.length
    ? [...new Set(profile.panels.map(String))]
    : [...PANELS.connection, ...PANELS.machine];

  /* A client app has no console to show panels in — it has its own window. */
  const console = profile.console === undefined ? role !== 'client' : Boolean(profile.console);
  /* Only the machine's own app runs the service. A client that tried to would
   * fight the real one over the port, and a laptop has no printer to run. */
  const supervises = profile.supervises === undefined ? role === 'machine' : Boolean(profile.supervises);
  if (supervises && role !== 'machine') {
    throw new Error(`${id}: only the machine's app may supervise the print service`);
  }
  if (console && role === 'client') {
    throw new Error(`${id}: a client app has no console window`);
  }

  return Object.freeze({
    id,
    role,
    appId: String(profile.appId || `app.printbridge.${id}`),
    productName: String(profile.productName || `PrintBridge ${id}`),
    /** The word under the logo in the console: whose machine are you looking at. */
    tagline: String(profile.tagline || ''),
    windowTitle: String(profile.windowTitle || profile.productName || 'PrintBridge'),
    /** Where the console opens when nothing else is remembered. */
    home: String(profile.home || (panels[0] ? `#/${panels[0]}` : '#/setup')),
    panels: Object.freeze(panels),
    console,
    supervises,
    /** A client app lists machines and prints; it never sees the console. */
    picksMachine: Boolean(profile.picksMachine),
    /** The mode this app opens the console in when it cannot reach anything. */
    offlineHint: String(profile.offlineHint || ''),
    /** electron-builder reads this to name the installer. */
    artifactName: String(profile.artifactName || `PrintBridge-${id}-\${version}.\${ext}`),
  });
}

module.exports = { normalize, ROLES, PANELS };
