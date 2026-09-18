/* PrintBridge smoke test — exercises the whole pipeline against a running
 * server, and the guest/admin separation around it.
 *
 *   node scripts/smoke.cjs                       (guest surface only)
 *   ADMIN_PIN=123456 node scripts/smoke.cjs      (adds the admin checks)
 *   BASE=http://192.168.1.20:8088 node scripts/smoke.cjs
 *
 * Works with any print backend: with no printer attached the outbox backend
 * receives the job, which still proves conversion → preview → print end to end.
 */
'use strict';

const assert = require('assert');
const sharp = require('sharp');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const BASE = process.env.BASE || 'http://localhost:8088';
const GS = '/api/v1';        // guest surface
const AS = '/api/admin';     // control room
const DEVICE_A = 'dev_smoke_aaaaaaaa';
const DEVICE_B = 'dev_smoke_bbbbbbbb';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let adminCookie = '';
const warned = [];

async function call(path, { method = 'GET', body, device = null, form = null, admin = false, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (device) headers['x-device-id'] = device;
  if (admin && adminCookie) headers.cookie = adminCookie;

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: form || (body !== undefined ? JSON.stringify(body) : undefined),
  });

  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json().catch(() => null) : null;
  if (raw) return { res, payload };
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status} ${(payload && payload.error) || ''}`);
    err.status = res.status;
    throw err;
  }
  return type.includes('json') ? payload : Buffer.from(await res.arrayBuffer());
}

const get = (path, opts) => call(path, opts);
const post = (path, body, opts = {}) => call(path, { ...opts, method: 'POST', body });
const del = (path, opts) => call(path, { ...opts, method: 'DELETE' });

/* ---------------- fixtures ---------------- */

async function makePdf() {
  const pdf = await PDFDocument.create();
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= 3; p++) {
    const page = pdf.addPage([595.28, 841.89]);
    page.drawRectangle({ x: 0, y: 700, width: 595.28, height: 90, color: rgb(0.04, 0.24, 0.23) });
    page.drawText('PrintBridge smoke test', { x: 44, y: 740, size: 22, font: bold, color: rgb(1, 1, 1) });
    page.drawText(`Page ${p} of 3 — if you can read this, text rendered correctly.`, { x: 44, y: 620, size: 13, font });
    for (let i = 0; i < 18; i++) {
      page.drawText(`Line ${i + 1}: the quick brown fox jumps over the lazy dog 0123456789`, { x: 44, y: 580 - i * 18, size: 10, font, color: rgb(0.2, 0.2, 0.2) });
    }
  }
  return Buffer.from(await pdf.save());
}

async function makePng() {
  const svg = `<svg width="900" height="600" xmlns="http://www.w3.org/2000/svg">
    <rect width="900" height="600" fill="#0b3d36"/>
    <circle cx="300" cy="300" r="150" fill="#129e8d"/>
    <rect x="500" y="180" width="300" height="240" fill="#ffffff"/>
    <text x="520" y="260" font-size="42" font-family="Helvetica" fill="#0b3d36">Photo test</text>
    <text x="520" y="320" font-size="24" font-family="Helvetica" fill="#0b3d36">900 x 600</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const TEXT_FIXTURE = Buffer.from(
  ['PrintBridge text fixture', '', 'col1,col2,col3', '1,alpha,ok', '2,beta,ok', '3,gamma,ok', '', 'End of file.'].join('\n'),
  'utf8'
);

/* ---------------- SSE listener ---------------- */

function listenToEvents(path, { device = null, admin = false } = {}) {
  const controller = new AbortController();
  const seen = [];
  const headers = {};
  if (device) headers['x-device-id'] = device;
  if (admin && adminCookie) headers.cookie = adminCookie;

  const task = (async () => {
    const res = await fetch(BASE + path, { signal: controller.signal, headers });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        const event = (chunk.match(/^event: (.+)$/m) || [])[1];
        if (event) seen.push(event);
      }
    }
  })().catch(() => {});
  return { seen, stop: () => { controller.abort(); return task; } };
}

/* ---------------- main ---------------- */

async function main() {
  const step = (msg) => console.log(`  • ${msg}`);
  const warn = (msg) => { warned.push(msg); console.log(`  ! ${msg}`); };

  /* 1 — who is this server ------------------------------------------------ */
  const meta = await get(`${GS}/system/meta`);
  assert(meta.appName, 'meta.appName missing');
  step(`server: ${meta.appName} v${meta.version} on ${meta.platform} — admin at ${meta.adminUrl}${meta.adminProtected ? ' (PIN protected)' : ' (open)'}`);

  /* 2 — the gate ---------------------------------------------------------- */
  const guarded = await call(`${AS}/jobs`, { admin: false, raw: true });
  assert.strictEqual(guarded.res.status, 401, 'admin API must refuse anonymous callers');
  step('admin API refuses anonymous callers (401)');

  const noDevice = await call(`${GS}/jobs`, { raw: true });
  assert.strictEqual(noDevice.res.status, 400, 'guest API must require a device id');
  step('guest API requires a device id (400)');

  const pin = process.env.ADMIN_PIN;
  if (pin) {
    const wrong = await call(`${AS}/login`, { method: 'POST', body: { pin: 'definitely-wrong' }, raw: true });
    assert.strictEqual(wrong.res.status, 401, 'a wrong PIN must be rejected');
    step('wrong PIN rejected');

    const res = await fetch(`${BASE}${AS}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    assert.strictEqual(res.status, 200, `admin login failed (${res.status})`);
    const setCookie = res.headers.get('set-cookie') || '';
    adminCookie = (setCookie.match(/pb_admin=[^;]+/) || [''])[0];
    assert(adminCookie, 'login did not return a session cookie');
    step('signed in to the admin API with the session cookie');

    const session = await get(`${AS}/session`, { admin: true });
    assert.strictEqual(session.authenticated, true, 'session not authenticated after login');
  } else {
    warn('ADMIN_PIN not set — admin checks are skipped (start the server with ADMIN_PIN=…)');
  }

  /* 3 — printer + live stream -------------------------------------------- */
  const { printer } = await get(`${GS}/printer/status`);
  step(`print path (guest view): ${printer ? `${printer.label} · ${printer.status}` : 'unknown'}${printer && printer.ready ? '' : ' — no printer ready'}`);

  const guest = listenToEvents(`${GS}/system/events?device=${DEVICE_A}`, { device: DEVICE_A });
  step(`subscribed to the guest stream for ${DEVICE_A}`);

  const adminStream = adminCookie ? listenToEvents(`${AS}/system/events`, { admin: true }) : null;
  if (adminStream) step('subscribed to the admin stream');

  /* 4 — upload + isolation ----------------------------------------------- */
  const created = [];
  try {
    const form = new FormData();
    form.append('files', new Blob([await makePdf()], { type: 'application/pdf' }), 'smoke-document.pdf');
    form.append('files', new Blob([await makePng()], { type: 'image/png' }), 'smoke-image.png');
    form.append('files', new Blob([TEXT_FIXTURE], { type: 'text/plain' }), 'smoke-notes.txt');
    form.append('copies', '1');

    const upload = await call(`${GS}/jobs`, { method: 'POST', form, device: DEVICE_A });
    assert(upload.jobs && upload.jobs.length === 3, `expected 3 jobs, got ${JSON.stringify(upload).slice(0, 200)}`);
    created.push(...upload.jobs.map(j => j.id));
    step(`uploaded 3 files as ${DEVICE_A} → batch ${upload.batchId}`);

    const mine = await get(`${GS}/jobs`, { device: DEVICE_A });
    assert(mine.jobs.length >= 3, 'owner cannot see its own jobs');
    const theirs = await get(`${GS}/jobs`, { device: DEVICE_B });
    assert.strictEqual(theirs.jobs.length, 0, 'a different device can see jobs that are not its own');
    const peek = await call(`${GS}/jobs/${created[0]}`, { device: DEVICE_B, raw: true });
    assert.strictEqual(peek.res.status, 404, 'another device can fetch someone else\'s job');
    const peekPrint = await call(`${GS}/jobs/${created[0]}/print`, { device: DEVICE_B, method: 'POST', body: {}, raw: true });
    assert.strictEqual(peekPrint.res.status, 404, 'another device can print someone else\'s job');
    step('guest isolation holds: another device sees and prints nothing of ours');

    // conversion
    const deadline = Date.now() + 60000;
    let jobs;
    for (;;) {
      jobs = (await get(`${GS}/jobs`, { device: DEVICE_A })).jobs.filter(j => created.includes(j.id));
      if (jobs.every(j => !['uploading', 'converting'].includes(j.status))) break;
      if (Date.now() > deadline) throw new Error('timed out waiting for conversion');
      await sleep(700);
    }
    for (const job of jobs) assert.strictEqual(job.status, 'ready', `${job.name} ended up ${job.status}: ${job.error}`);

    const pdfJob = jobs.find(j => j.name.endsWith('.pdf'));
    const imgJob = jobs.find(j => j.name.endsWith('.png'));
    const txtJob = jobs.find(j => j.name.endsWith('.txt'));
    step(`converted: pdf ${pdfJob.pageCount}p · png ${imgJob.pageCount}p · txt ${txtJob.pageCount}p`);
    assert.strictEqual(pdfJob.pageCount, 3, 'expected a 3-page PDF');

    // preview fidelity: rendered pages must contain ink (the standard-font trap)
    for (const job of [pdfJob, imgJob, txtJob]) {
      const page = Buffer.from(await get(`${GS}/files/${job.id}/preview/1.png`, { device: DEVICE_A }));
      const stats = await sharp(page).stats();
      const stdev = Math.max(...stats.channels.map(c => c.stdev));
      assert(stdev > 3, `${job.name}: preview looks blank (stdev ${stdev.toFixed(2)})`);
      step(`preview ok: ${job.name} (stdev ${stdev.toFixed(1)}, ${(page.length / 1024).toFixed(0)} KB)`);
    }

    const page3 = await get(`${GS}/files/${pdfJob.id}/preview/3.png`, { device: DEVICE_A });
    assert(Buffer.isBuffer(page3) && page3.length > 1000, 'page 3 preview missing');
    step('lazy page render ok (page 3)');

    const bad = await call(`${GS}/files/${pdfJob.id}/preview/999.png`, { device: DEVICE_A, raw: true });
    assert.strictEqual(bad.res.status, 404, 'expected 404 for out-of-range page');
    step('out-of-range page correctly rejected');

    // A renamed/corrupt "pdf" is accepted as a job (the bytes have to be read
    // first) but conversion must reject it instead of feeding the printer.
    const fakeForm = new FormData();
    fakeForm.append('files', new Blob([Buffer.from('this is not a pdf at all')], { type: 'application/pdf' }), 'not-really.pdf');
    const fake = await call(`${GS}/jobs`, { method: 'POST', form: fakeForm, device: DEVICE_A });
    assert.strictEqual(fake.jobs.length, 1, 'the upload itself should be accepted');
    created.push(...fake.jobs.map(j => j.id));

    const fakeDeadline = Date.now() + 30000;
    let fakeJob;
    for (;;) {
      fakeJob = await get(`${GS}/jobs/${fake.jobs[0].id}`, { device: DEVICE_A });
      if (['failed', 'ready'].includes(fakeJob.status)) break;
      if (Date.now() > fakeDeadline) throw new Error('timed out waiting for the corrupt PDF to settle');
      await sleep(400);
    }
    assert.strictEqual(fakeJob.status, 'failed', 'a non-PDF was accepted as a printable document');
    assert(/not a valid PDF/i.test(fakeJob.error), `unexpected rejection message: ${fakeJob.error}`);
    step(`corrupt PDF refused ("${fakeJob.error.slice(0, 48)}…")`);

    /* 5 — print ------------------------------------------------------------ */
    await post(`${GS}/jobs/${pdfJob.id}/print`, { copies: 1, paper: 'a4' }, { device: DEVICE_A });
    step('print command sent');

    const printDeadline = Date.now() + 90000;
    let printedJob;
    for (;;) {
      printedJob = await get(`${GS}/jobs/${pdfJob.id}`, { device: DEVICE_A });
      if (['printed', 'failed'].includes(printedJob.status)) break;
      if (Date.now() > printDeadline) throw new Error(`timed out printing (status ${printedJob.status})`);
      await sleep(800);
    }
    assert.strictEqual(printedJob.status, 'printed', `print failed: ${printedJob.error}`);
    step(`printed via ${printedJob.backend}: ${printedJob.message}`);

    await post(`${GS}/jobs/${pdfJob.id}/print`, { copies: 1 }, { device: DEVICE_A });
    await sleep(50);
    const cancelable = await get(`${GS}/jobs/${pdfJob.id}`, { device: DEVICE_A });
    if (['queued', 'printing'].includes(cancelable.status)) {
      await post(`${GS}/jobs/${pdfJob.id}/cancel`, {}, { device: DEVICE_A });
      step('cancel accepted while job was active');
    } else {
      step('job finished before cancel was possible (fine)');
    }

    /* 6 — print codes and the printer picker ------------------------------ */
    const target = (await get(`${GS}/printers`));
    assert(Array.isArray(target.printers) && target.printers.length > 0, 'no printers offered to guests');
    assert(target.printers.every(p => p.id && p.name), 'a printer is missing its id or name');
    step(`printer picker: ${target.printers.map(p => `${p.name} (${p.kind})`).join(', ')}`);

    // Send the same document to the outbox explicitly, by target id.
    const outboxTarget = target.printers.find(p => p.id === 'outbox');
    assert(outboxTarget, 'the outbox is not offered as a target');
    const sent = await post(`${GS}/jobs/${imgJob.id}/print`, { target: 'outbox' }, { device: DEVICE_A });
    assert(/^PB-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(sent.token || ''), `print code looks wrong: ${sent.token}`);
    step(`print code issued: ${sent.token} → ${sent.target}`);

    const done = await (async () => {
      const until = Date.now() + 60000;
      for (;;) {
        const job = await get(`${GS}/jobs/${imgJob.id}`, { device: DEVICE_A });
        if (['printed', 'failed'].includes(job.status)) return job;
        if (Date.now() > until) throw new Error('timed out waiting for the targeted print');
        await sleep(600);
      }
    })();
    assert.strictEqual(done.status, 'printed', `targeted print failed: ${done.error}`);
    const ticket = done.tickets.find(t => t.token === sent.token);
    assert(ticket, 'the issued ticket is missing from the job');
    assert.strictEqual(ticket.state, 'printed', `ticket should be printed, is ${ticket.state}`);
    step(`ticket followed the job: ${ticket.token} → ${ticket.state} via ${ticket.backend}`);

    const lookup = await get(`${GS}/tickets/${sent.token.replace(/-/g, '').toLowerCase()}`, { device: DEVICE_A });
    assert.strictEqual(lookup.ticket.state, 'printed', 'token lookup returned the wrong state');
    step('token lookup works, including when it is typed without dashes');

    const foreign = await call(`${GS}/tickets/${sent.token}`, { device: DEVICE_B, raw: true });
    assert.strictEqual(foreign.res.status, 404, 'another device could look up our print code');
    step('print codes are scoped to the device that made them');

    const badTarget = await call(`${GS}/jobs/${imgJob.id}/print`, { device: DEVICE_A, method: 'POST', body: { target: 'spooler:does-not-exist' }, raw: true });
    assert(badTarget.res.status === 409, 'printing to an unavailable printer should be refused');
    step('printing to an unavailable printer is refused with a clear error');

    /* 7 — the guest stream carries our jobs and nothing else -------------- */
    assert(guest.seen.includes('hello'), 'guest SSE hello missing');
    assert(guest.seen.includes('job'), 'guest SSE job events missing');
    step(`guest SSE events: ${[...new Set(guest.seen)].join(', ')}`);
    assert(!guest.seen.includes('log'), 'guest stream must not carry server logs');

    /* 8 — admin side ------------------------------------------------------- */
    if (adminCookie) {
      const all = await get(`${AS}/jobs?limit=50`, { admin: true });
      const ours = all.jobs.filter(j => created.includes(j.id));
      assert.strictEqual(ours.length, created.length, 'admin cannot see every guest job');
      assert(ours.every(j => j.owner === DEVICE_A), 'admin view lost the job owner');
      step(`admin sees all ${all.jobs.length} job(s), with owners attributed`);

      if (printedJob.backend === 'outbox') {
        const outbox = await get(`${AS}/files/outbox.json`, { admin: true });
        assert(outbox.files.length > 0, 'no files in the outbox');
        assert(outbox.files[0].size > 1000, 'outbox file looks empty');
        step(`outbox contains ${outbox.files.length} file(s), newest ${outbox.files[0].name}`);
      }

      const card = await get(`${AS}/system/pairing/card.pdf`, { admin: true });
      assert(Buffer.isBuffer(card) && card.slice(0, 4).toString() === '%PDF', 'pairing card is not a PDF');
      step(`pairing card generated (${(card.length / 1024).toFixed(0)} KB)`);

      const diag = await get(`${AS}/system/diagnostics`, { admin: true });
      step(`diagnostics: uptime ${diag.uptimeSeconds}s · storage ${(diag.storage.totalBytes / 1024).toFixed(0)} KB · engine ${diag.tools.silentPrintReady ? 'ready' : 'missing'}`);

      const backends = await get(`${AS}/printer/backends`, { admin: true });
      assert(Array.isArray(backends.backends) && backends.backends.length > 0, 'no print backends reported');
      step(`admin print paths: ${backends.backends.map(b => `${b.id}${b.available ? '' : '(unavailable)'}`).join(', ')}`);

      await sleep(400);
      assert(adminStream.seen.includes('hello'), 'admin SSE hello missing');
      assert(adminStream.seen.includes('log'), 'admin stream should carry server logs');
      step(`admin SSE events: ${[...new Set(adminStream.seen)].join(', ')}`);
    }
  } finally {
    guest.stop();
    if (adminStream) adminStream.stop();
    for (const id of created) await del(`${GS}/jobs/${id}`, { device: DEVICE_A }).catch(() => {});
    console.log(`  • cleaned up ${created.length} test job(s)`);
  }

  if (warned.length) console.log(`\n  SMOKE PASS (with ${warned.length} skipped check(s))\n`);
  else console.log('\n  SMOKE PASS\n');
}

main().catch((e) => {
  console.error('\n  SMOKE FAIL\n', e.message, '\n');
  process.exit(1);
});
