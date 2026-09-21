'use strict';
/* The app's own host.
 *
 * The desktop window is not pointed at the print service — it is pointed at
 * this: a loopback-only web server that serves the app's own interface from
 * disk and *proxies everything else* to the print service.
 *
 * That one decision buys three things:
 *
 *   1. One origin. The console, the API, the preview images and the SSE stream
 *      are all `http://127.0.0.1:<host port>/…`, so the session cookie is simply
 *      sent. No CORS, no ALLOWED_ORIGINS, no cookie juggling in the renderer.
 *   2. No admin surface on the network. The console is no longer served by the
 *      print service, so there is no `/admin` URL to find on the LAN — the only
 *      way to reach this interface is through the app on this machine.
 *   3. The guest page still works from inside the app, because `/print/` and
 *      `/owner/` are proxied like everything else.
 *
 * It binds 127.0.0.1 on an ephemeral port. Nothing outside this machine can
 * reach it, and it dies with the app.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/* Headers that describe *this* hop and must not be copied upstream or back. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade',
]);

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** Serve a file from one of the app's own directories, never outside them. */
function serveFile(res, baseDir, relative) {
  const target = path.resolve(baseDir, relative);
  if (target !== baseDir && !target.startsWith(baseDir + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  return fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': contentType(target),
      'Content-Length': stat.size,
      // The interface is on disk next to the app: always take the current copy,
      // so an update is never masked by a cached shell.
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(target).pipe(res);
  });
}

function filterHeaders(headers, target) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === 'host') continue;
    /* The browser's Origin describes *this* hop — the window talking to the host
     * that served it — and it must not travel upstream. Forwarding it made the
     * machine read a request from its own console as a cross-site call from
     * http://127.0.0.1:<port>: harmless while the console sat beside the service
     * (both loopback, so the machine recognised a local pair), but a 403 the
     * moment the console is pointed at a machine across the network — which is
     * precisely what the shop's and the customer's apps do. The host is the
     * client of the print service here, exactly like curl or a native app, and
     * the machine already treats a request with no Origin as trusted. */
    if (key.toLowerCase() === 'origin') continue;
    out[key] = value;
  }
  out.host = `${target.host}:${target.port}`;
  return out;
}

/**
 * Start the host.
 *
 * @param {object} opts
 * @param {string} opts.root       the renderer directory (index.html lives here)
 * @param {string} opts.publicDir  the project's public/ (shared CSS + modules)
 * @param {() => ({host: string, port: number}|null)} opts.target
 *        the machine to proxy to, read live: this machine's own service in the
 *        machine's app, the chosen machine on the network in the shop's app.
 *        Null (nothing chosen, or a service that is down) is an answer too —
 *        the console loads anyway, which is when you most need to be told.
 * @param {(message: string) => void} [opts.log]
 */
function start({ root, publicDir, target, log = () => {} }) {
  const rootDir = path.resolve(root);
  const publicRoot = path.resolve(publicDir);
  let port = null;

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Bad request');
    }

    // -------- the app's own files --------
    if (pathname === '/' || pathname === '/index.html') {
      return serveFile(res, rootDir, 'index.html');
    }
    if (pathname === '/renderer' || pathname.startsWith('/renderer/')) {
      return serveFile(res, rootDir, pathname.slice('/renderer/'.length));
    }
    /* The shared design system (app.css, ui.js, theme.js) lives in public/ and
     * is imported by the console with paths relative to /renderer/…, which
     * lands here. Serving it from disk keeps one copy of those modules — and,
     * more importantly, keeps the interface loading when the print service is
     * down, which is exactly when you need to be told that it is down. */
    if (pathname.startsWith('/public/')) {
      return serveFile(res, publicRoot, pathname.slice('/public/'.length));
    }
    /* /app/* and /assets/* are the same files under their real directory names,
     * which is how the console already imports them. */
    if (pathname.startsWith('/app/') || pathname.startsWith('/assets/')) {
      return serveFile(res, publicRoot, pathname.slice(1));
    }

    // -------- everything else belongs to a print service, somewhere --------
    const machine = target();
    if (!machine) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'No print service is reachable — the machine is not running, or no machine has been chosen' }));
    }

    const upstream = http.request({
      host: machine.host,
      port: machine.port,
      path: req.url,
      method: req.method,
      headers: filterHeaders(req.headers, machine),
    }, (up) => {
      const headers = {};
      for (const [key, value] of Object.entries(up.headers)) {
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        headers[key] = value;
      }
      res.writeHead(up.statusCode || 502, headers);
      up.pipe(res);
    });

    upstream.on('error', (error) => {
      if (res.headersSent) return res.end();
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `The print service at ${machine.host}:${machine.port} did not answer (${error.message})` }));
    });

    req.on('aborted', () => upstream.destroy());

    /* The admin event stream is a long-lived response: no buffering, no idle
     * timeout on either side, and no Nagle delay on the first byte. */
    if (String(req.headers.accept || '').includes('text/event-stream')) {
      req.socket.setNoDelay(true);
      req.socket.setKeepAlive(true);
      res.setTimeout(0);
      upstream.setTimeout(0);
      res.setHeader('X-Accel-Buffering', 'no');
    }

    req.pipe(upstream);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      log(`interface host on http://127.0.0.1:${port}`);
      resolve({
        port,
        get url() { return `http://127.0.0.1:${port}/`; },
        close: () => new Promise((done) => {
          server.close(() => done());
          // Sockets held open by a live event stream must not hold the app open.
          setTimeout(() => { try { server.closeAllConnections(); } catch { /* older node */ } done(); }, 1200);
        }),
      });
    });
  });
}

module.exports = { start };
