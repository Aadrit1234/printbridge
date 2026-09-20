'use strict';
/* PrintBridge Client — the customer's app: print, without a browser.
 *
 *   npm run desktop:client             (development)
 *   release/PrintBridge-Client-*.exe   (packaged)
 *
 * It finds printer machines on the network and opens the one you use, so the
 * walk-up flow becomes a thing you double-click. See desktop/shared/client-app.js.
 */

require('../../shared/client-app').start(require('./profile'));
