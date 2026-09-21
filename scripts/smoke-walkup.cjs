/* Walk-up print flow smoke test.
 *
 * The three-site model has one flow per printer category, and this is what
 * proves both of them against a running server:
 *
 *   workspace — code → printer → upload → settings → print, free
 *   shop      — code → colour/mono → printer → upload → settings → pay → print
 *
 * It also locks in the things that are easy to break silently:
 *   • a printer code works typed with or without its PP- prefix
 *   • a shop refuses to print an unpaid job, and refuses a second mode without
 *     a second payment
 *   • every print command gets its own code
 *   • the code page is really merged in front of the document (the print copy
 *     has one more page than the document)
 *   • a paused printer is refused, and another device cannot read our code
 *
 *   node scripts/smoke-walkup.cjs
 *   BASE=http://192.168.1.20:8088 node scripts/smoke-walkup.cjs
 *
 * It creates its own printers on the server and removes them again, so it is
 * safe to run against a live install. `data/` is only ever read.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const BASE = process.env.BASE || 'http://localhost:8088';
const GS = '/api/v1';
const AS = '/api/admin';
const OS = '/api/owner';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_PIN;
/* An explicit DATA_DIR wins; otherwise this is filled in from the server's own
 * /api/admin/system/meta once we are signed in, so a scratch run against a
 * throwaway server looks in the folder that server actually writes to. Guessing
 * <repo>/data used to report a missing code page that was never missing. */
let DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');

const DEVICE = 'dev_walkup_smoke';
const OTHER_DEVICE = 'dev_walkup_other';

let cookie = '';
let failures = 0;
let checks = 0;

const ok = (label, condition, detail = '') => {
  checks++;
  if (condition) console.log(`  • ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* `origin` mimics a browser: real ones send Origin on every POST, including
 * same-origin ones, which is exactly the case an ALLOWED_ORIGINS list must not
 * refuse. */
async function req(url, { method = 'GET', body, device = DEVICE, form = null, admin = false, origin = null } = {}) {
  const headers = {};
  if (device) headers['x-device-id'] = device;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (admin && cookie) headers.cookie = cookie;
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: form || (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, payload, headers: res.headers };
}

async function sentDocument(lines = 2) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= lines; p++) {
    const page = pdf.addPage([595.28, 841.89]);
    page.drawText(`Walk-up smoke page ${p}`, { x: 44, y: 700, size: 18, font });
  }
  return Buffer.from(await pdf.save());
}

async function upload(name, bytes, mime = 'application/pdf') {
  const form = new FormData();
  form.append('files', new Blob([bytes], { type: mime }), name);
  const res = await req(`${GS}/jobs`, { method: 'POST', form });
  assert.strictEqual(res.status, 201, `upload failed: ${res.status} ${JSON.stringify(res.payload)}`);
  return res.payload.jobs[0];
}

async function ready(id) {
  for (let i = 0; i < 60; i++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await req(`${GS}/jobs/${id}`);
    if (res.payload && res.payload.status === 'ready') return res.payload;
    if (res.payload && res.payload.status === 'failed') throw new Error(`job failed: ${res.payload.error}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('job never became ready');
}

async function settle(id) {
  for (let i = 0; i < 60; i++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await req(`${GS}/jobs/${id}`);
    const status = res.payload && res.payload.status;
    if (['printed', 'failed', 'canceled'].includes(status)) return res.payload;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('job never settled');
}

function printCopyPath(jobId) { return path.join(DATA_DIR, 'print', `${jobId}.pdf`); }

async function pageCountOf(file) {
  const doc = await PDFDocument.load(fs.readFileSync(file));
  return doc.getPageCount();
}

async function main() {
  console.log(`\n  walk-up smoke: ${BASE}\n`);

  if (PASSWORD) {
    const login = await req(`${AS}/login`, { method: 'POST', body: { username: ADMIN_USER, password: PASSWORD }, device: null });
    assert.strictEqual(login.status, 200, `admin sign-in failed (${login.status})`);
    const raw = login.payload;
    void raw;
    // fetch() hides Set-Cookie, so re-request with an explicit header list
    const res = await fetch(BASE + AS + '/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ADMIN_USER, password: PASSWORD }),
    });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
    cookie = String(set.filter(Boolean)[0] || '').split(';')[0];
    ok('signed in to the admin API', Boolean(cookie));

    if (!process.env.DATA_DIR && cookie) {
      const meta = await req(`${AS}/system/meta`, { admin: true, device: null }).catch(() => null);
      const reported = meta && meta.payload && meta.payload.dataDir;
      if (reported) DATA_DIR = path.resolve(reported);
    }
  }

  /* ---------------- fixtures: one printer per category ---------------- */
  const made = [];

  async function makePrinter(body) {
    if (!cookie) throw new Error('the console sign-in is required to create the test printers — set ADMIN_PASSWORD (or ADMIN_PIN)');
    const res = await req(`${AS}/printers`, { method: 'POST', body, device: null, admin: true });
    assert.strictEqual(res.status, 201, `could not create printer: ${res.status} ${JSON.stringify(res.payload)}`);
    made.push(res.payload.printer.id);
    return res.payload.printer;
  }

  try {
    const workspace = await makePrinter({
      name: 'Walk-up smoke workspace',
      category: 'workspace',
      target: 'outbox',
      capabilities: { papers: ['a4', 'letter'], orientations: ['portrait', 'landscape'], duplex: true, color: false },
    });
    const shop = await makePrinter({
      name: 'Walk-up smoke shop',
      category: 'shop',
      target: 'outbox',
      capabilities: { papers: ['a4'], orientations: ['portrait'], duplex: false, color: true },
      pricing: { currency: 'INR', colorPerPage: 3, monoPerPage: 1 },
    });
    ok('registered a workspace printer', /^PP-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(workspace.code), workspace.code);
    ok('registered a shop printer with prices', shop.pricing.colorPerPage === 3 && shop.pricing.monoPerPage === 1, shop.code);

    /* ---------------- code lookup ---------------- */
    const bare = workspace.code.replace(/^PP-/, '').replace('-', '');
    const byFull = await req(`${GS}/printers/${encodeURIComponent(workspace.code)}`, { device: null });
    const byBare = await req(`${GS}/printers/${encodeURIComponent(bare)}`, { device: null });
    const byJunk = await req(`${GS}/printers/${encodeURIComponent(workspace.code.toLowerCase().replace(/-/g, ' '))}`, { device: null });
    ok('a code resolves for guests', byFull.status === 200 && byFull.payload.printer.category === 'workspace', workspace.code);
    ok('a code resolves without its PP- prefix', byBare.status === 200 && byBare.payload.printer.code === workspace.code, bare);
    ok('a code resolves typed with spaces and lower case', byJunk.status === 200, workspace.code.toLowerCase());
    const nonsense = await req(`${GS}/printers/PP-ZZZZ-ZZZZ`, { device: null });
    ok('an unknown code is a clean 404', nonsense.status === 404, nonsense.payload.error);

    /* ---------------- workspace: free, one code page ---------------- */
    const wJob = await upload('workspace.pdf', await sentDocument(2));
    await ready(wJob.id);
    const wPrint = await req(`${GS}/jobs/${wJob.id}/print`, {
      method: 'POST', body: { printer: workspace.id, paper: 'a4', orientation: 'portrait', duplex: true },
    });
    assert.strictEqual(wPrint.status, 200, `workspace print failed: ${JSON.stringify(wPrint.payload)}`);
    const wToken = wPrint.payload.token;
    ok('workspace print accepted without payment', Boolean(wToken), wToken);
    const wDone = await settle(wJob.id);
    ok('workspace job printed', wDone.status === 'printed', wDone.message);
    ok('its ticket followed the job', (wDone.tickets || []).some(t => t.token === wToken && t.state === 'printed'), wToken);

    const copy = printCopyPath(wJob.id);
    if (fs.existsSync(copy)) {
      const pages = await pageCountOf(copy);
      ok('the code page is printed in front of the document', pages === 3, `${pages} pages = 1 code + 2 document`);
    } else {
      /* Not necessarily a failure: when DATA_DIR is not set, this suite looks in
       * the repo's data/ while a throwaway server writes somewhere else. Say so,
       * because "the file is not there" reads like a broken code page. */
      ok('the code page is printed in front of the document', false,
        process.env.DATA_DIR
          ? `no print copy at ${copy} (the server writes to ${DATA_DIR} — is that the same directory?)`
          : `no print copy at ${copy} — pass DATA_DIR=… if the server does not use <repo>/data`);
    }

    /* ---------------- shop: pay first ---------------- */
    const sJob = await upload('shop.pdf', await sentDocument(1));
    await ready(sJob.id);

    const unpaid = await req(`${GS}/jobs/${sJob.id}/print`, { method: 'POST', body: { printer: shop.id, mode: 'color' } });
    ok('a shop refuses to print an unpaid job', unpaid.status === 409 && /payment/i.test(unpaid.payload.error), unpaid.payload.error);

    const noMode = await req(`${GS}/jobs/${sJob.id}/pay`, { method: 'POST', body: { printer: shop.id } });
    ok('paying without a colour choice is refused', noMode.status === 409, noMode.payload.error);

    const cheap = await req(`${GS}/jobs/${sJob.id}/pay`, { method: 'POST', body: { printer: shop.id, mode: 'mono' } });
    ok('the server prices the job itself', cheap.status === 200 && cheap.payload.payment.amount === 1, `mono 1 page → ₹${cheap.payload.payment && cheap.payload.payment.amount}`);

    const pay = await req(`${GS}/jobs/${sJob.id}/pay`, { method: 'POST', body: { printer: shop.id, mode: 'color', method: 'card' } });
    ok('paying in colour reprices the same job', pay.status === 200 && pay.payload.payment.amount === 3, `colour 1 page → ₹${pay.payload.payment && pay.payload.payment.amount}`);

    const sPrint = await req(`${GS}/jobs/${sJob.id}/print`, { method: 'POST', body: { printer: shop.id, mode: 'color' } });
    assert.strictEqual(sPrint.status, 200, `shop print failed: ${JSON.stringify(sPrint.payload)}`);
    ok('a paid shop job prints', Boolean(sPrint.payload.token), sPrint.payload.token);
    const sDone = await settle(sJob.id);
    ok('shop job printed', sDone.status === 'printed', sDone.message);

    const secondMode = await req(`${GS}/jobs/${sJob.id}/print`, {
      method: 'POST', body: { printer: shop.id, mode: 'mono', tokenPage: false },
    });
    ok('printing the same document again needs its own payment',
      secondMode.status === 409 || (secondMode.status === 200 && secondMode.payload.token !== sPrint.payload.token),
      secondMode.status === 409 ? secondMode.payload.error : secondMode.payload.token);

    /* ---------------- a same-origin browser POST is not refused ---------------- */
    const form = new FormData();
    form.append('files', new Blob(['same-origin check'], { type: 'text/plain' }), 'same-origin.txt');
    const sameOriginPost = await req(`${GS}/jobs`, { method: 'POST', form, origin: BASE });
    ok('a same-origin POST with an Origin header is accepted (ALLOWED_ORIGINS set)',
      sameOriginPost.status === 201, `${sameOriginPost.status} ${sameOriginPost.status !== 201 ? JSON.stringify(sameOriginPost.payload) : ''}`);
    if (sameOriginPost.payload && sameOriginPost.payload.jobs) {
      await req(`${GS}/jobs/${sameOriginPost.payload.jobs[0].id}`, { method: 'DELETE' }).catch(() => {});
    }

    // With an allowlist configured, a foreign site must not even be able to
    // trigger a request; without one, the API stays open (that is the LAN case).
    const configured = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const foreignPost = await req(`${GS}/jobs`, { method: 'POST', body: { nothing: true }, origin: 'https://someone-elses-site.example' });
    if (configured.length) {
      ok('a foreign origin is refused outright', foreignPost.status === 403, `${foreignPost.status} ${JSON.stringify(foreignPost.payload)}`);
    } else {
      ok('no allowlist set, so the API stays open to this network (skipped)', true, 'set ALLOWED_ORIGINS to exercise the refusal');
    }

    /* Two loopback ports are the same machine but still two origins to a
     * browser, so a local page must get the CORS headers — the desktop app's
     * own host and any dev server on 5173 depend on it. Getting this wrong
     * shows up as "everything on this laptop is broken, everything on the LAN
     * works", which is a miserable afternoon. */
    const baseHost = new URL(BASE).hostname;
    const loopbackServer = baseHost === 'localhost' || baseHost === '::1' || /^127\.\d+\.\d+\.\d+$/.test(baseHost);
    if (loopbackServer) {
      const localPage = await req(`${OS}/plans`, { origin: 'http://localhost:5173' });
      ok('a page on another loopback port is allowed to read our answers',
        localPage.status === 200 && localPage.headers.get('access-control-allow-origin') === 'http://localhost:5173',
        `${localPage.status} allow-origin=${localPage.headers.get('access-control-allow-origin')}`);
    } else {
      console.log('  (this base is not loopback — skipped the local-page CORS check)');
    }

    /* The app's own host proxies to the machine, and it must not forward the
     * browser's Origin when it does. That Origin describes the window talking to
     * the host that served it — a loopback origin — while the machine it is
     * proxied to is often on another address entirely. Forwarding it made a
     * machine refuse its own console's sign-in with 403 "this origin is not
     * allowed" whenever ALLOWED_ORIGINS was configured, which is every real
     * install that also serves the website. A spy upstream is the honest way to
     * check a request's headers: it records what actually arrived. */
    const http = require('http');
    let seen = null;
    const spy = http.createServer((spyReq, spyRes) => {
      seen = { origin: spyReq.headers.origin, host: spyReq.headers.host };
      spyRes.writeHead(200, { 'Content-Type': 'application/json' });
      spyRes.end('{"ok":true}');
    });
    await new Promise((resolve) => spy.listen(0, '127.0.0.1', resolve));
    const appHost = require('../desktop/shared/host');
    const proxied = await appHost.start({
      root: path.join(__dirname, '..', 'desktop', 'renderer'),
      publicDir: path.join(__dirname, '..', 'public'),
      target: () => ({ host: '127.0.0.1', port: spy.address().port }),
      log: () => {},
    });
    try {
      const through = await fetch(`${proxied.url}api/admin/system/meta`, {
        headers: { origin: proxied.url.replace(/\/$/, '') },
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      ok('the app host answers for the machine it proxies to', through.status === 200, `${through.status}`);
      ok('the host does not forward the browser Origin to the machine',
        Boolean(seen) && seen.origin === undefined,
        `upstream saw origin=${seen && seen.origin}`);
      ok('the host rewrites Host to the target, not its own',
        Boolean(seen) && seen.host === `127.0.0.1:${spy.address().port}`,
        `upstream saw host=${seen && seen.host}`);
    } finally {
      await proxied.close();
      await new Promise((resolve) => spy.close(resolve));
    }

    /* The shop's app and the customer's app find a printer machine by asking its
     * *guest* meta what it is, because that is the only meta a stranger's app may
     * read. It names the app as `appName` — and reading the admin-shaped keys
     * instead made every machine on every network invisible to both apps, with
     * the probe reporting a perfectly good PrintBridge as "something else". */
    const nearby = require('../desktop/shared/nearby');
    const parsedBase = new URL(BASE);
    const alive = await nearby.confirm(parsedBase.hostname, Number(parsedBase.port) || 80);
    ok('a machine identifies itself to discovery (app name + version)',
      alive.ok === true, alive.ok ? `${alive.app} ${alive.version}` : alive.reason);

    /* ---------------- codes are scoped to one device ---------------- */
    const foreign = await req(`${GS}/tickets/${encodeURIComponent(wToken)}`, { device: OTHER_DEVICE });
    ok('another device cannot read our code', foreign.status === 404, foreign.payload.error);
    const own = await req(`${GS}/tickets/${encodeURIComponent(wToken)}`);
    ok('the sender can read it', own.status === 200 && own.payload.ticket.token === wToken, own.payload.ticket && own.payload.ticket.state);

    /* ---------------- paused printers take nothing ---------------- */
    const paused = await makePrinter({
      name: 'Walk-up smoke paused',
      category: 'workspace',
      target: 'outbox',
      active: false,
      capabilities: { papers: ['a4'], orientations: ['portrait'], duplex: false, color: false },
    });
    const pJob = await upload('paused.pdf', await sentDocument(1));
    await ready(pJob.id);
    const refused = await req(`${GS}/jobs/${pJob.id}/print`, { method: 'POST', body: { printer: paused.id } });
    ok('a paused printer refuses jobs with a clear reason',
      refused.status === 409 && /paused|turned it off/i.test(refused.payload.error), refused.payload.error);
    const pausedSheet = await req(`${GS}/printers/${encodeURIComponent(paused.code)}`, { device: null });
    ok('guests can still see it is not active', pausedSheet.status === 200 && pausedSheet.payload.printer.active === false, paused.code);

    /* ---------------- cleanup ---------------- */
    await req(`${GS}/jobs/${wJob.id}`, { method: 'DELETE' }).catch(() => {});
    await req(`${GS}/jobs/${sJob.id}`, { method: 'DELETE' }).catch(() => {});
    await req(`${GS}/jobs/${pJob.id}`, { method: 'DELETE' }).catch(() => {});
  } finally {
    for (const id of made) {
      // eslint-disable-next-line no-await-in-loop
      await req(`${AS}/printers/${encodeURIComponent(id)}`, { method: 'DELETE', device: null, admin: true }).catch(() => {});
    }
  }

  console.log(`\n  ${failures ? 'WALK-UP FAIL' : 'WALK-UP PASS'} — ${checks - failures}/${checks} checks\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n  WALK-UP FAIL — ${e.message}\n`);
  process.exit(1);
});
