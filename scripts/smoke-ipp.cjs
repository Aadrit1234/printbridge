/* Wi-Fi (IPP / AirPrint) end-to-end test.
 *
 * Point PrintBridge at a simulated network printer, print a real document over
 * IPP, and check what actually reached the printer — then prove the two things
 * a remote print depends on:
 *
 *   • a printer that refuses the richer job attributes still prints (fallback)
 *   • a job sent while the printer is unreachable keeps trying, and prints
 *     by itself the moment the printer comes back
 *
 *   ADMIN_PASSWORD=… node scripts/smoke-ipp.cjs
 *   ADMIN_PASSWORD=… BASE=http://192.168.1.20:8088 node scripts/smoke-ipp.cjs
 *
 * The script starts scripts/fake-printer.cjs on a free port, switches the
 * server's print connection to it, and restores the previous settings and jobs
 * when it finishes. Your printer is never involved.
 */
'use strict';

const assert = require('assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const BASE = process.env.BASE || 'http://localhost:8088';
const GS = '/api/v1';
const AS = '/api/admin';
const DEVICE = 'dev_ipp_smoke';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_PIN;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let cookie = '';
const warned = [];

/* ---------------- http helpers ---------------- */

async function call(pathname, { method = 'GET', body, form, device, raw = false } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (device) headers['x-device-id'] = device;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: form || (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json().catch(() => null) : await res.text();
  if (raw) return { res, payload };
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status} ${(payload && payload.error) || ''}`);
  return payload;
}

const get = (p, o) => call(p, o);
const post = (p, body, o = {}) => call(p, { ...o, method: 'POST', body });
const patch = (p, body, o = {}) => call(p, { ...o, method: 'PATCH', body });
const del = (p, o) => call(p, { ...o, method: 'DELETE' });

async function waitForJob(id, statuses, timeoutMs, onTick) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await get(`${GS}/jobs/${id}`, { device: DEVICE, raw: true }).then(r => r.payload);
    if (onTick) onTick(last);
    if (last && statuses.includes(last.status)) return last;
    if (Date.now() > deadline) return last;
    await sleep(600);
  }
}

/* ---------------- fixture ---------------- */

async function makePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595.28, 841.89]);
  page.drawText('PrintBridge Wi-Fi (IPP) test page', { x: 44, y: 760, size: 20, font });
  for (let i = 0; i < 12; i++) page.drawText(`Line ${i + 1}: sent over IPP, not USB.`, { x: 44, y: 700 - i * 20, size: 12, font });
  return Buffer.from(await pdf.save());
}

/* ---------------- the simulated printer ---------------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Start scripts/fake-printer.cjs and collect the requests it received. */
async function startPrinter({ rejectOptions = false, port = null } = {}) {
  const chosen = port || await freePort();
  const proc = spawn(process.execPath, [path.join(__dirname, 'fake-printer.cjs')], {
    env: { ...process.env, PORT: String(chosen), REJECT_OPTIONS: rejectOptions ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const entries = [];
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const match = line.match(/^PRINTER (.*)$/);
      if (!match) continue;
      try { entries.push(JSON.parse(match[1])); } catch { /* ignore */ }
    }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the simulated printer did not start')), 8000);
    const check = () => {
      if (entries.some(e => e.listening)) { clearTimeout(timer); resolve(); }
    };
    proc.stdout.on('data', check);
    proc.on('exit', () => { clearTimeout(timer); reject(new Error('the simulated printer exited')); });
  });

  const jobs = () => entries.filter(e => e.operation === 'Print-Job' && e.accepted);
  return {
    port: chosen,
    entries,
    jobs,
    stop: () => new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', () => resolve());
      proc.kill('SIGTERM');
      setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 3000).unref();
    }),
  };
}

/* ---------------- main ---------------- */

async function main() {
  const step = (msg) => console.log(`  • ${msg}`);
  const warn = (msg) => { warned.push(msg); console.log(`  ! ${msg}`); };

  if (!PASSWORD) {
    console.error('\n  This test drives the admin API to point the server at the simulated printer.');
    console.error('  Run it with the console sign-in:  ADMIN_PASSWORD=… node scripts/smoke-ipp.cjs\n');
    process.exit(1);
  }

  const meta = await get(`${GS}/system/meta`);
  step(`server: ${meta.appName} v${meta.version} (${BASE})`);

  const login = await fetch(`${BASE}${AS}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ADMIN_USER, password: PASSWORD }),
  });
  assert.strictEqual(login.status, 200, `admin sign-in failed (${login.status})`);
  cookie = (login.headers.get('set-cookie') || '').match(/pb_admin=[^;]+/)[0];
  assert(cookie, 'no session cookie returned');
  step('signed in to the admin API');

  const before = await get(`${AS}/system/settings`, { raw: false });
  step(`current print path: ${before.backend}${before.printerUrl ? ` → ${before.printerUrl}` : ''}`);

  const created = [];
  let printer = null;
  let restore = null;
  let printerPort = null;

  try {
    /* 1 — a network printer that behaves ---------------------------------- */
    printer = await startPrinter({ rejectOptions: false });
    printerPort = printer.port;
    step(`simulated Wi-Fi printer listening on 127.0.0.1:${printerPort}`);

    await patch(`${AS}/system/settings`, { backend: 'ipp', printerUrl: `127.0.0.1:${printerPort}`, retryWindowMinutes: 5 });
    restore = { backend: before.backend, printerUrl: before.printerUrl, retryWindowMinutes: before.retryWindowMinutes };

    const status = await get(`${AS}/printer/status?fresh=1`);
    assert.strictEqual(status.active.id, 'ipp', `expected the ipp backend, got ${status.active.id}`);
    assert.strictEqual(status.state.status, 'ready', `printer not seen as ready: ${JSON.stringify(status.state)}`);
    assert(/simulated|Fake/i.test(status.state.name || ''), `printer name was not read back (got "${status.state.name}")`);
    assert((status.state.markers || []).some(m => typeof m.level === 'number'), 'supply levels were not read back');
    step(`printer read back: "${status.state.name}" · ${status.state.status} · ${status.state.detail} · ${status.state.markers[0].name} ${status.state.markers[0].level}%`);

    /* 2 — print over IPP -------------------------------------------------- */
    const form = new FormData();
    form.append('files', new Blob([await makePdf()], { type: 'application/pdf' }), 'wifi-ipp-test.pdf');
    form.append('copies', '2');
    form.append('duplex', 'true');
    const upload = await call(`${GS}/jobs`, { method: 'POST', form, device: DEVICE });
    const jobId = upload.jobs[0].id;
    created.push(jobId);

    for (let i = 0; i < 60; i++) {
      const job = await get(`${GS}/jobs/${jobId}`, { device: DEVICE });
      if (job.status === 'ready') break;
      if (job.status === 'failed') throw new Error(`conversion failed: ${job.error}`);
      await sleep(500);
    }

    await post(`${GS}/jobs/${jobId}/print`, { copies: 2, duplex: true, paper: 'a4', scale: 'fit' }, { device: DEVICE });
    const printed = await waitForJob(jobId, ['printed', 'failed'], 90000);
    assert.strictEqual(printed.status, 'printed', `print failed: ${printed.error}`);
    assert.strictEqual(printed.backend, 'ipp', `expected the ipp backend, got ${printed.backend}`);
    assert(printed.printerJobId, 'the printer job id was not read back from the IPP response');

    // Only look at documents carrying our job name: a leftover job from an
    // earlier run may still be delivered to the printer by the retry loop.
    const mine = printer.jobs().filter(e => e.name === 'wifi-ipp-test.pdf');
    assert(mine.length >= 1, `our document never reached the printer (saw ${printer.jobs().length} other document(s))`);
    const doc = mine[mine.length - 1];
    assert(doc.docLooksLikePdf && doc.docBytes > 500, 'the printer did not receive a PDF');
    assert.strictEqual(doc.media, 'iso_a4_210x297mm', `wrong media: ${doc.media}`);
    assert.strictEqual(doc.copies, 2, `wrong copies: ${doc.copies}`);
    assert.strictEqual(doc.sides, 'two-sided-long-edge', `duplex was not honoured: ${doc.sides}`);
    assert.strictEqual(doc.printScaling, 'fit', `scaling was not honoured: ${doc.printScaling}`);
    step(`printed over IPP as #${printed.printerJobId}: ${(doc.docBytes / 1024).toFixed(0)} KB PDF · ${doc.media} · ${doc.sides} · ${doc.copies} copies · scaling=${doc.printScaling}`);

    /* 3 — a printer that refuses the extra options ------------------------ */
    await printer.stop();
    printer = await startPrinter({ rejectOptions: true, port: printerPort }); // fresh log
    await post(`${GS}/jobs/${jobId}/print`, { copies: 1, duplex: true, paper: 'a4', scale: 'fit' }, { device: DEVICE });
    const fallback = await waitForJob(jobId, ['printed', 'failed'], 90000);
    assert.strictEqual(fallback.status, 'printed', `fallback print failed: ${fallback.error}`);
    assert(/basic options/i.test(fallback.message || ''), `expected a basic-options fallback, got "${fallback.message}"`);
    const afterFallback = printer.jobs().filter(e => e.name === 'wifi-ipp-test.pdf');
    assert(afterFallback.length >= 1, 'the fallback document never reached the printer');
    const basic = afterFallback[afterFallback.length - 1];
    assert.strictEqual(basic.media, 'iso_a4_210x297mm', 'the fallback dropped the paper size too');
    step(`printer refused the extra attributes; the job still printed (${basic.media}, no scaling) — "${fallback.message}"`);

    /* 4 — the printer is gone, then comes back ---------------------------- */
    await printer.stop();
    printer = null;
    await post(`${GS}/jobs/${jobId}/print`, { copies: 1 }, { device: DEVICE });

    let sawWaiting = false;
    const waiting = await waitForJob(jobId, ['waiting'], 40000, (job) => {
      if (job && job.status === 'waiting') sawWaiting = true;
    });
    assert(sawWaiting, `a job sent to an unreachable printer did not queue up (last status ${waiting && waiting.status})`);
    step(`printer unreachable → job held: "${waiting.phase}" — ${waiting.message}`);

    printer = await startPrinter({ rejectOptions: false, port: printerPort });
    step(`printer back on 127.0.0.1:${printer.port} — waiting for it to print on its own…`);
    const resumed = await waitForJob(jobId, ['printed', 'failed'], 60000);
    assert.strictEqual(resumed.status, 'printed', `the waiting job never printed after the printer returned: ${resumed.error || resumed.message}`);
    step(`unattended resume worked: printed via ${resumed.backend} after ${resumed.attempts} attempt(s) — "${resumed.message}"`);
  } finally {
    if (printer) await printer.stop();
    if (restore) {
      await patch(`${AS}/system/settings`, restore).catch(() => warn('could not restore the previous print settings'));
      console.log(`  • print path restored to ${restore.backend}${restore.printerUrl ? ` → ${restore.printerUrl}` : ''}`);
    }
    for (const id of created) {
      await post(`${GS}/jobs/${id}/cancel`, {}, { device: DEVICE }).catch(() => {});
      await del(`${GS}/jobs/${id}`, { device: DEVICE }).catch(() => {});
    }
    console.log(`  • cleaned up ${created.length} test job(s)`);
  }

  if (warned.length) console.log(`\n  IPP PASS (with ${warned.length} warning(s))\n`);
  else console.log('\n  IPP PASS\n');
}

main().catch((e) => {
  console.error('\n  IPP FAIL\n', e.message, '\n');
  process.exit(1);
});
