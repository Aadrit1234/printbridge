'use strict';
/* Announcing this machine to the other PrintBridge apps on the same network.
 *
 * A printer machine would otherwise be an address somebody has to know. It
 * advertises itself over mDNS instead, so the shop app and the client app can
 * list the machines that are actually reachable and connect to one without
 * anybody typing an IP:
 *
 *   _printbridge._tcp
 *     txt: v      service version (this file's protocol, not the app's)
 *          app   PrintBridge's version, so an app can say "newer than me"
 *          name  what the machine calls itself
 *          tier  workspace | shop — what it was licensed as
 *          path  where the guest print page lives, for the client app
 *
 * Discovery is not authentication: anything on the network may browse this, and
 * a client that finds a machine still has to present a code (or sign in) to do
 * anything with it. This only removes the typing.
 */

const log = require('../logger').make('nearby');

const SERVICE_TYPE = 'printbridge';
const PROTOCOL = 1;

let bonjour = null;
let service = null;

function Bonjour() {
  const mod = require('bonjour-service');
  return mod.default || mod.Bonjour;
}

/**
 * Advertise the print service. Failure is never fatal — a machine whose network
 * blocks multicast still serves everyone who knows its address.
 */
function advertise({ port, name, tier, version, path: guestPath = '/print/' }) {
  try {
    const Ctor = Bonjour();
    bonjour = new Ctor();
    service = bonjour.publish({
      name: String(name || 'PrintBridge').slice(0, 60),
      type: SERVICE_TYPE,
      protocol: 'tcp',
      port: Number(port) || 8088,
      txt: {
        v: String(PROTOCOL),
        app: String(version || ''),
        name: String(name || 'PrintBridge').slice(0, 60),
        tier: String(tier || 'workspace'),
        path: String(guestPath),
      },
    });
    service.on('error', (error) => log.debug(`mDNS publish error: ${error.message}`));
    log.info(`announcing this machine on the network as "${name}" (_${SERVICE_TYPE}._tcp)`);
    return true;
  } catch (error) {
    log.warn(`could not announce this machine on the network: ${error.message}`);
    return false;
  }
}

function stop() {
  try { if (bonjour) bonjour.destroy(); } catch { /* already gone */ }
  bonjour = null;
  service = null;
}

module.exports = { advertise, stop, SERVICE_TYPE, PROTOCOL };
