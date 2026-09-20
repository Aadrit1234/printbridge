'use strict';
/* The machine's own app: it runs the printer.
 *
 * This is the one to install on the PC the printer is plugged into. It starts
 * the print service, keeps it running, sets the printer up, and holds the
 * console — the machine's own operations and nothing else. A shop's prices,
 * expenses and takings are not here on purpose: those belong to the business,
 * which is a licence, not a machine.
 */

module.exports = require('../../shared/profile').normalize({
  id: 'workspace',
  role: 'machine',
  appId: 'app.printbridge.workspace',
  productName: 'PrintBridge Workspace',
  windowTitle: 'PrintBridge Workspace — this machine',
  tagline: 'this machine',
  /* Setup first: on a fresh install it is the page that says what is missing. */
  home: '#/setup',
  panels: ['setup', 'queue', 'codes', 'printers', 'printer', 'settings', 'access', 'account'],
  picksMachine: false,
  offlineHint: 'This machine runs the printer. If it cannot reach its own service, the app can restart it below.',
  artifactName: 'PrintBridge-Workspace-${version}.${ext}',
});
