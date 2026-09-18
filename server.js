'use strict';
/* PrintBridge — bootstrap.
 *
 *   node server.js          →  http://localhost:8088
 *
 * The server keeps itself running: printer state polling, USB queue
 * auto-selection, retention cleanup, and a QR banner you can scan from a phone. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');

/**
 * .env support, without a dependency: KEY=value lines in ./.env become
 * defaults, and anything already in the real environment wins — so a service
 * manager (systemd, Task Scheduler, Docker) can still override the file.
 * This is where ALLOWED_ORIGINS and friends belong on a permanent install.
 */
function loadEnvFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnvFile(path.join(__dirname, '.env'));

const PORT = parseInt(process.env.PORT, 10) || 8088;
const HOST = process.env.HOST || '0.0.0.0';
/* Resolved, not just joined: a relative DATA_DIR (DATA_DIR=./tmp) would make
 * every stored file path relative, and Express refuses to sendFile one. */
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  // Prefer everyday home/office ranges over virtual adapters.
  const score = (ip) => (/^192\.168\.(1|0|2|4|8|9|10)\./.test(ip) ? 3 : /^192\.168\./.test(ip) ? 2 : /^10\./.test(ip) ? 1 : 0);
  return out.sort((a, b) => score(b) - score(a));
}

function banner(baseUrl, extra) {
  const printUrl = `${baseUrl}/print`;
  return QRCode.toString(printUrl, { type: 'terminal', small: true, margin: 1 }).then((qr) => {
    const lines = [
      '',
      '  ┌─────────────────────────────────────────────┐',
      '  │  PrintBridge is running                     │',
      '  └─────────────────────────────────────────────┘',
      '',
      `  Local     http://localhost:${PORT}`,
      ...extra.addresses.map(a => `  Network   ${a}`),
      '',
      '  Guests scan this to print (no app, no account):',
      '',
      qr.split('\n').filter(Boolean).map(l => '  ' + l).join('\n'),
      '',
      `  Main site    ${baseUrl}          (about · product · pricing · contact)`,
      `  Print site   ${printUrl}          (what the QR points at)`,
      `  Admin site   ${extra.admin.url}`,
      `  Owner site   ${baseUrl}/owner          (sign in with your access code)`,
      ...(extra.walkUp && extra.walkUp.length
        ? ['', '  Walk-up printer codes (enter these on the print site):',
           ...extra.walkUp.map(p => `    ${p.code}   ${p.name} · ${p.category}${p.active === false ? ' (paused)' : ''}`)]
        : []),
      extra.admin.pin
        ? `  Admin PIN    ${extra.admin.pin}    (first run — change it in Admin → Access)`
        : '  Admin PIN    as you set it (Admin → Access to change)',
      '',
      '  Owners sign in at /owner with the access code from their licence email.',
      extra.operator
        ? '  Operator key set — you can issue access codes from the code desk.'
        : '  Operator key   not set — no access codes can be issued (set OPERATOR_KEY in .env).',
      extra.owners
        ? `  Accounts     ${extra.owners} owner account(s) on this install`
        : '  Accounts     none yet — an account is created when a code is redeemed',
      '',
      `  Print path   ${extra.backend}`,
      `  Reason       ${extra.reason}`,
      '',
      `  Data directory: ${extra.dataDir}`,
      '',
    ];
    console.log(lines.join('\n'));
  }).catch(() => {
    console.log(`\n  PrintBridge running on ${baseUrl}\n`);
  });
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Config and storage must exist before anything that reads them is required.
  const config = require('./src/config');
  const storage = require('./src/storage');
  const logger = require('./src/logger');
  const auth = require('./src/auth');
  config.init(DATA_DIR);
  storage.init(DATA_DIR);
  /* Codes before accounts: an account can only be created from a redeemed
   * access code, so the code store has to know the plans first. */
  require('./src/services/access-codes').init(DATA_DIR);
  require('./src/services/accounts').init(DATA_DIR);
  auth.init(DATA_DIR);
  require('./src/services/printers').init(DATA_DIR);
  logger.setLevel(process.env.LOG_LEVEL || 'info');

  const watchdog = require('./src/services/watchdog');
  const registry = require('./src/services/backends/registry');
  const { createApp } = require('./src/app');

  const log = logger.make('server');
  watchdog.start();

  const addresses = lanAddresses().map(ip => `http://${ip}:${PORT}`);
  const lanUrl = addresses[0] || `http://localhost:${PORT}`;

  const app = createApp({ publicDir: path.join(__dirname, 'public'), lanUrl, lanAddresses: addresses });
  const server = app.listen(PORT, HOST, async () => {
    log.info(`listening on ${HOST}:${PORT}`);
    const snapshot = await registry.state({ fresh: true }).catch(() => null);
    banner(lanUrl, {
      addresses,
      backend: snapshot ? `${snapshot.active.label} (${snapshot.active.id})` : 'resolving…',
      reason: snapshot ? snapshot.reason : '',
      dataDir: DATA_DIR,
      admin: { url: `${lanUrl}/admin`, pin: auth.generatedPin },
      operator: Boolean(String(process.env.OPERATOR_KEY || '').trim().length >= 16),
      owners: require('./src/services/accounts').all().length,
      walkUp: require('./src/services/printers').all(),
    });
    if (snapshot && snapshot.state.detail) log.info(`printer detail: ${snapshot.state.detail}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is already in use. Start with PORT=8089 node server.js\n`);
    } else {
      console.error('Server error:', err.message);
    }
    process.exit(1);
  });

  const shutdown = async (signal) => {
    log.warn(`${signal} received — shutting down`);
    watchdog.stop();
    try { await storage.save(); } catch { /* noop */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error(`unhandled rejection: ${e && e.message ? e.message : e}`));
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
