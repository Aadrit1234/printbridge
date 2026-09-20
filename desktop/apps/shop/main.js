'use strict';
/* PrintBridge Shop — the owner's app: the printer machine, and the business.
 *
 *   npm run desktop:shop             (development)
 *   release/PrintBridge-Shop-*.exe   (packaged)
 *
 * It runs no print service of its own: it is pointed at a machine (the one the
 * printer is plugged into) and adds the panels a machine has no business
 * knowing — pricing, expenses, revenue. All of it is desktop/shared/app.js.
 */

require('../../shared/app').start(require('./profile'));
