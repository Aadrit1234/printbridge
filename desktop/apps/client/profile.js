'use strict';
/* The customer's app: print, without a browser.
 *
 * Somebody who prints every day should not have to find a QR code, open a phone
 * camera and type a code into a web page. This app lists the printer machines
 * on the network, remembers the one you use, and opens its print page in a
 * window of its own — so the walk-up flow that already exists becomes a thing
 * you double-click. If no machine is on this network, the walk-up code still
 * works from anywhere, and it is accepted here too.
 */

module.exports = require('../../shared/profile').normalize({
  id: 'client',
  role: 'client',
  appId: 'app.printbridge.client',
  productName: 'PrintBridge Client',
  windowTitle: 'PrintBridge — print a document',
  tagline: 'printers near you',
  console: false,
  supervises: false,
  picksMachine: true,
  artifactName: 'PrintBridge-Client-${version}.${ext}',
});
