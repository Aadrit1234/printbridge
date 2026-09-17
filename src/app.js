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

function createApp({ publicDir, lanUrl }) {
  const log = logger.make('http');
  bridgeSettings(require('./config'));
  const app = express();
  app.disable('x-powered-by');
  app.set('lanUrl', lanUrl);
  app.set('trust proxy', true);

  // Cross-origin support comes first: a preflight must be answered before the
  // admin gate (it carries no cookies, so the gate would reject it).
  const allowed = cors.allowedOrigins();
  if (allowed.length) log.info(`cross-origin access allowed for: ${allowed.join(', ')}`);
  app.use(cors.middleware());

  app.use(express.json({ limit: '256kb' }));

  // Two surfaces, on purpose:
  //   /api/v1     guest — upload, preview, print, own jobs only
  //   /api/admin  control room — every job, printer setup, defaults, storage
  app.use('/api/v1', require('./routes/guest'));
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
    // /admin is its own document, so a guest phone never downloads admin code.
    if (req.path === '/admin' || req.path.startsWith('/admin/')) {
      return res.sendFile(path.join(publicDir, 'admin', 'index.html'));
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
