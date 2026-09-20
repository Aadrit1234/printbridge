'use strict';
/* The owner's app: the business, from across the counter.
 *
 * It is a client, not a machine. It finds a printer machine on the network and
 * manages it from a laptop — the queue, the codes, the printers, the settings —
 * and on top of that it holds what a machine has no business knowing: what this
 * shop charges, what it spends, and what it took. Those three panels work
 * offline against a local copy of the shop's document and sync to the machine
 * when it is reachable, so a counter that loses Wi-Fi does not lose the day's
 * expenses with it.
 */

module.exports = require('../../shared/profile').normalize({
  id: 'shop',
  role: 'console',
  appId: 'app.printbridge.shop',
  productName: 'PrintBridge Shop',
  windowTitle: 'PrintBridge Shop — the business',
  tagline: 'connected machine',
  /* Connect first: nothing else means anything until a machine is chosen. */
  home: '#/connection',
  panels: [
    'connection',
    'queue',
    'codes',
    'printers',
    'printer',
    'pricing',
    'expenses',
    'reports',
    'settings',
    'access',
    'account',
  ],
  picksMachine: true,
  offlineHint: 'Choose the machine this shop prints at. The pricing, expenses and reports panels keep working without it.',
  artifactName: 'PrintBridge-Shop-${version}.${ext}',
});
