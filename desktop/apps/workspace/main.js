'use strict';
/* PrintBridge Workspace — the app that runs the printer.
 *
 *   npm run desktop:workspace        (development)
 *   release/PrintBridge-Workspace-*.exe   (packaged)
 *
 * Everything it does is in desktop/shared/app.js; this file says which app it is.
 */

require('../../shared/app').start(require('./profile'));
