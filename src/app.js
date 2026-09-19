'use strict';
/* Express assembly. Everything lives under /api/v1; the frontend is served
 * statically with ETag revalidation (no long-lived caching, so updates apply
 * on reload). */

const path = require('path');
const express = require('express');
const logger = require('./logger');
const bus = require('./events');
const cors = require('./cors');

/* Settings are a shared resource: any device can change the print defaults, and
 * the watchdog can pick up a queue on its own. Fan those changes out over the
 * event bus so every open browser repaints instead of silently drifting. */
let settingsBridged = false;
function bridgeSettings(settings) {
  if (settingsBridged) return;
  settingsBridged = true;
  settings.on('change', () => bus.emit('settings', { settings: settings.all() }));
}

function createApp({ publicDir, lanUrl, lanAddresses = [] }) {
  const log = logger.make('http');
  bridgeSettings(require('./config'));
  const app = express();
  app.disable('x-powered-by');
  app.set('lanUrl', lanUrl);
  // Every address the guest page can be reached at on this network, so the
  // console can show them instead of pretending one URL is all there is.
  app.set('lanAddresses', lanAddresses.length ? lanAddresses : [lanUrl].filter(Boolean));
  app.set('trust proxy', true);

  // Cross-origin support comes first: a preflight must be answered before the
  // admin gate (it carries no cookies, so the gate would reject it).
  const allowed = cors.allowedOrigins();
  if (allowed.length) log.info(`cross-origin access allowed for: ${allowed.join(', ')}`);
  app.use(cors.middleware());

  app.use(express.json({ limit: '256kb' }));

  // Four surfaces, on purpose:
  //   /api/v1     guest — upload, preview, print, own jobs only
  //   /api/owner  the customer: redeem an access code, sign in, own account,
  //               and (with the vendor's operator key) mint the codes
  //   /api/admin  control room — every job, printer setup, defaults, storage.
  //               The machine PIN sees the whole machine; an owner account sees
  //               only its own printers (req.scope)
  app.use('/api/v1', require('./routes/guest'));
  app.use('/api/owner', require('./routes/owner'));
  app.use('/api/admin', require('./routes/admin'));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));

  app.use(express.static(publicDir, {
    etag: true,
    lastModified: true,
    maxAge: 0,
    index: 'index.html',
    setHeaders(res, filePath) {
      // The shell, the service worker and the manifest must be revalidated on
      // every load: a stale shell paired with new modules is a broken app, and
      // that is exactly what an aggressive cache used to cause.
      if (/\.html$|sw\.js$|manifest\.webmanifest$|config\.js$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  app.use((req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
    /* The console is not a web page any more. It runs inside the desktop app,
     * which serves its own interface on loopback — so there is nothing here for
     * somebody who finds this address on the network, and saying so is better
     * than quietly serving the marketing page instead. */
    if (req.path === '/admin' || req.path.startsWith('/admin/')
      || req.path === '/desktop' || req.path.startsWith('/desktop/')) {
      res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send([
        '<!doctype html><html lang="en"><meta charset="utf-8">',
        '<meta name="robots" content="noindex">',
        '<title>PrintBridge</title>',
        '<body style="margin:0;background:#0b111d;color:#f2eee6;',
        'font:16px/1.6 \'Segoe UI\',system-ui,sans-serif;display:grid;place-items:center;height:100vh">',
        '<div style="max-width:34rem;padding:2rem">',
        '<h1 style="font:600 1.4rem Georgia,serif;margin:0 0 .6rem">The console lives in the app</h1>',
        '<p style="color:#c3cadd">PrintBridge\'s control room is part of the desktop app on the machine that',
        ' owns the printer, not a page on this network. Install and open PrintBridge there.</p>',
        '<p style="color:#8e9ab6;margin-top:1.4rem"><a style="color:#8ea2ff" href="/print/">Guests print here →</a></p>',
        '</div></body></html>',
      ].join('\n'));
    }
    return res.status(404).sendFile(path.join(publicDir, 'index.html'));
  });

  app.use((err, req, res, next) => {
    log.error(`${req.method} ${req.originalUrl} — ${err.message}`);
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Server error' });
  });

  return app;
}

module.exports = { createApp };
