/* Shop business data smoke test.
 *
 * The rule this suite exists to protect: a shop's books belong to its licence,
 * and the numbers in them are the shop's — not the machine's, not the browser's,
 * and never somebody else's.
 *
 *   OPERATOR_KEY=… ADMIN_PASSWORD=… node scripts/smoke-shop.cjs
 *   BASE=http://192.168.1.20:8088 OPERATOR_KEY=… ADMIN_PASSWORD=… node scripts/smoke-shop.cjs
 *
 * Checks, in order:
 *   • the document is empty and knows the vocabulary a panel needs
 *   • the machine sign-in is refused — a machine keeps books for nobody
 *   • an anonymous caller gets nothing
 *   • a sync adds records, and the merge is newest-wins per record
 *   • an old copy of a record does not overwrite a newer one
 *   • a delete stays deleted (a tombstone is not resurrected by a stale copy)
 *   • another licence sees an empty document, not this one
 *   • reports count expenses, and revenue only from this account's printers
 *   • a paid job at somebody else's printer contributes nothing
 *   • the CSV is the same numbers, flattened
 *
 * Everything it creates is removed before it exits, so it is safe to run
 * against a live install.
 */
'use strict';

const { PDFDocument, StandardFonts } = require('pdf-lib');

const BASE = process.env.BASE || 'http://localhost:8088';
const GS = '/api/v1';
const OS = '/api/owner';
const AS = '/api/admin';
const SS = '/api/shop';
const OPERATOR_KEY = process.env.OPERATOR_KEY || '';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_PIN || '';
const DEVICE = 'dev_shop_smoke';

let checks = 0;
let failures = 0;

const ok = (label, condition, detail = '') => {
  checks++;
  if (condition) console.log(`  • ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

function cookieOf(res) {
  const raw = res.headers.get('set-cookie') || '';
  const first = raw.split(';')[0];
  return first.includes('=') ? first : '';
}

async function req(url, { method = 'GET', body, form = null, cookie = '', key = '', device = null } = {}) {
  const h = {};
  if (device) h['x-device-id'] = device;
  if (cookie) h.cookie = cookie;
  if (key) h['x-operator-key'] = key;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, {
    method,
    headers: h,
    body: form || (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, payload, cookie: cookieOf(res), type };
}

const now = () => new Date().toISOString();
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

async function sentDocument(pages = 1) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= pages; p++) {
    const page = pdf.addPage([595.28, 841.89]);
    page.drawText(`Shop smoke page ${p}`, { x: 44, y: 700, size: 18, font });
  }
  return Buffer.from(await pdf.save());
}

async function upload(bytes) {
  const form = new FormData();
  form.append('files', new Blob([bytes], { type: 'application/pdf' }), 'shop-smoke.pdf');
  const res = await req(`${GS}/jobs`, { method: 'POST', form, device: DEVICE });
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.payload)}`);
  return res.payload.jobs[0];
}

async function ready(jobId) {
  for (let i = 0; i < 60; i++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await req(`${GS}/jobs/${jobId}`, { device: DEVICE });
    const status = res.payload && res.payload.status;
    if (status === 'ready') return res.payload;
    if (status === 'failed') throw new Error(`job failed: ${res.payload.error}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('job never became ready');
}

/* A paid print at one printer, start to finish. Returns what it cost. */
async function printAndPay(printer, mode, { pages = 1 } = {}) {
  const job = await upload(await sentDocument(pages));
  await ready(job.id);
  const pay = await req(`${GS}/jobs/${job.id}/pay`, { method: 'POST', body: { printer: printer.id, mode, method: 'card' }, device: DEVICE });
  if (pay.status !== 200) throw new Error(`pay failed: ${pay.status} ${JSON.stringify(pay.payload)}`);
  const print = await req(`${GS}/jobs/${job.id}/print`, { method: 'POST', body: { printer: printer.id, mode }, device: DEVICE });
  if (print.status !== 200) throw new Error(`print failed: ${print.status} ${JSON.stringify(print.payload)}`);
  return { job, amount: pay.payload.payment.amount };
}

const created = { accountIds: [], printerIds: [], jobIds: [], codeIds: [] };

async function main() {
  console.log(`\n  shop smoke: ${BASE}\n`);

  const stamp = Date.now().toString(36);
  let adminCookie = '';
  if (PASSWORD) {
    const res = await fetch(`${BASE}${AS}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ADMIN_USER, password: PASSWORD }),
    });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
    adminCookie = String(set.filter(Boolean)[0] || '').split(';')[0];
    ok('signed in to the machine', Boolean(adminCookie));
  }

  if (!OPERATOR_KEY) {
    console.log('\n  OPERATOR_KEY is not set — this suite needs it to mint the licence codes it tests with.\n');
    return finish();
  }

  /* ---------------- a licence, and therefore an account ---------------- */

  async function licence(plan) {
    const minted = await req(`${OS}/codes`, { method: 'POST', key: OPERATOR_KEY, body: { plan, note: `shop smoke ${stamp}` } });
    if (minted.status !== 201) throw new Error(`could not mint a code: ${minted.status} ${JSON.stringify(minted.payload)}`);
    created.codeIds.push(minted.payload.code.id);
    const email = `shop-smoke+${stamp}-${plan}-${Math.random().toString(36).slice(2, 6)}@example.test`;
    const signup = await req(`${OS}/signup`, {
      method: 'POST', body: { code: minted.payload.code.code, email, name: 'Shop smoke', password: 'smoke-test-password' },
    });
    if (signup.status !== 201) throw new Error(`could not create the account: ${signup.status} ${JSON.stringify(signup.payload)}`);
    created.accountIds.push(signup.payload.account.id);
    return { cookie: signup.cookie, account: signup.payload.account, email };
  }

  const shop = await licence('shop-lifetime');
  ok('a licence code created the shop account', Boolean(shop.cookie) && shop.account.plan === 'shop-lifetime', shop.account.plan);

  /* ---------------- who may read the books ---------------- */

  const anon = await req(`${SS}/`);
  ok('an anonymous caller gets nothing', anon.status === 401, anon.status);

  if (adminCookie) {
    const asMachine = await req(`${SS}/`, { cookie: adminCookie });
    ok('the machine sign-in is refused — books belong to a licence, not a machine',
      asMachine.status === 400 && /owner account/i.test(String(asMachine.payload && asMachine.payload.error)),
      `${asMachine.status} ${asMachine.payload && asMachine.payload.error}`);
  } else {
    console.log('  (no console password given — skipping the machine check)');
  }

  const empty = await req(`${SS}/`, { cookie: shop.cookie });
  ok('a new shop starts with an empty document',
    empty.status === 200 && empty.payload.expenses.length === 0 && empty.payload.services.length === 0,
    empty.status);
  ok('and the document carries the vocabulary a panel needs',
    Boolean(empty.payload.vocabulary) && empty.payload.vocabulary.categories.includes('paper') && empty.payload.vocabulary.currencies.includes('INR'),
    empty.payload.vocabulary && empty.payload.vocabulary.categories.join('/'));

  /* ---------------- syncing ---------------- */

  const expenseA = { id: 'exp_a', date: '2026-09-01', category: 'paper', vendor: 'Sri Paper', amount: 2400, currency: 'INR', updatedAt: ago(120) };
  const expenseB = { id: 'exp_b', date: '2026-09-02', category: 'toner', vendor: 'Ink House', amount: 1800, currency: 'INR', updatedAt: ago(120) };
  const expenseC = { id: 'exp_c', date: '2026-09-03', category: 'wages', vendor: 'Ravi', amount: 5000, currency: 'INR', updatedAt: ago(120) };

  const first = await req(`${SS}/sync`, {
    method: 'POST',
    cookie: shop.cookie,
    body: {
      settings: { currency: 'INR', taxPercent: 18, updatedAt: ago(120) },
      services: [{ id: 'svc_lamin', label: 'Lamination', kind: 'perPage', amount: 10, currency: 'INR', updatedAt: ago(120) }],
      expenses: [expenseA, expenseB, expenseC],
    },
  });
  ok('a sync stores the shop document',
    first.status === 200 && first.payload.expenses.length === 3 && first.payload.settings.taxPercent === 18,
    `expenses: ${first.payload && first.payload.expenses.length}, tax: ${first.payload && first.payload.settings.taxPercent}`);
  ok('the machine keeps a copy too (it is not returned empty again)',
    (await req(`${SS}/`, { cookie: shop.cookie })).payload.expenses.length === 3);

  /* An old copy of a record must lose. This is the ordinary case: a laptop that
   * was closed while somebody edited the same row on another machine. */
  const stale = await req(`${SS}/sync`, {
    method: 'POST',
    cookie: shop.cookie,
    body: {
      settings: { currency: 'INR', taxPercent: 18, updatedAt: ago(120) },
      services: [],
      expenses: [
        { ...expenseA, amount: 999, updatedAt: ago(600) },
        { ...expenseB, amount: 1800, vendor: 'Ink House, MG Road', updatedAt: now() },
      ],
    },
  });
  const afterStale = Object.fromEntries(stale.payload.expenses.map(e => [e.id, e]));
  ok('an older copy of a record does not overwrite the newer one', afterStale.exp_a.amount === 2400, `₹${afterStale.exp_a.amount}`);
  ok('a newer copy of a record wins', afterStale.exp_b.vendor === 'Ink House, MG Road', afterStale.exp_b.vendor);
  ok('a sync hands back the whole document, so both sides converge',
    stale.payload.expenses.length === 3 && stale.payload.services.length === 1, `${stale.payload.expenses.length} expenses, ${stale.payload.services.length} service`);

  /* A delete travels as a tombstone — otherwise the next sync from the machine
   * that never saw the delete would quietly bring the record back. */
  const deleted = await req(`${SS}/sync`, {
    method: 'POST',
    cookie: shop.cookie,
    body: {
      settings: { currency: 'INR', taxPercent: 18, updatedAt: ago(120) },
      services: [],
      expenses: [{ ...expenseC, deletedAt: now(), updatedAt: now() }],
    },
  });
  const resurrect = await req(`${SS}/sync`, {
    method: 'POST',
    cookie: shop.cookie,
    body: {
      settings: { currency: 'INR', taxPercent: 18, updatedAt: ago(120) },
      services: [],
      expenses: [expenseC],
    },
  });
  const afterDelete = Object.fromEntries(resurrect.payload.expenses.map(e => [e.id, e]));
  ok('a deleted record stays deleted when a stale copy arrives', Boolean(afterDelete.exp_c && afterDelete.exp_c.deletedAt),
    afterDelete.exp_c ? `deleted at ${afterDelete.exp_c.deletedAt}` : 'the record came back');
  void deleted;

  /* ---------------- nobody else's books ---------------- */

  const other = await licence('workspace-lifetime');
  const theirView = await req(`${SS}/`, { cookie: other.cookie });
  ok("another licence sees an empty document, not this shop's",
    theirView.status === 200 && theirView.payload.expenses.length === 0 && theirView.payload.services.length === 0,
    `${theirView.payload && theirView.payload.expenses.length} expense(s)`);

  /* ---------------- revenue, and whose revenue it is ---------------- */

  if (!adminCookie) {
    console.log('  (no console password given — skipping the revenue checks, which need a printer)');
    return finish();
  }

  const made = await req(`${AS}/printers`, {
    method: 'POST',
    cookie: shop.cookie,
    body: {
      name: 'Shop smoke counter',
      category: 'shop',
      target: 'outbox',
      capabilities: { papers: ['a4'], orientations: ['portrait'], duplex: false, color: true },
      pricing: { currency: 'INR', colorPerPage: 3, monoPerPage: 1.5 },
    },
  });
  if (made.status !== 201) throw new Error(`could not register the shop's printer: ${made.status} ${JSON.stringify(made.payload)}`);
  const mine = made.payload.printer;
  created.printerIds.push(mine.id);
  ok("an owner account can register a printer, and it belongs to them", mine.accountId === shop.account.id, mine.code);

  const paid = await printAndPay(mine, 'mono', { pages: 2 });
  created.jobIds.push(paid.job.id);
  ok('a paid job at the shop printer cost what the prices say', paid.amount === 3, `2 mono pages → ₹${paid.amount}`);

  /* Somebody else's printer is somebody else's revenue. */
  const demo = await req(`${GS}/printers/PP-PTST-4SHP`, { device: DEVICE });
  if (demo.status === 200 && demo.payload.printer && demo.payload.printer.active !== false) {
    const elsewhere = await printAndPay(demo.payload.printer, 'mono', { pages: 1 });
    created.jobIds.push(elsewhere.job.id);
    ok("a paid job at another licence's printer is possible", elsewhere.amount > 0, `₹${elsewhere.amount}`);
  } else {
    console.log('  (the seeded demo shop printer is not here — skipping the attribution check)');
  }

  const report = await req(`${SS}/reports?from=2026-09-01`, { cookie: shop.cookie });
  const totals = report.payload && report.payload.totals;
  ok('reports count only jobs printed at this account\u2019s printers',
    report.status === 200 && totals.jobs === 1 && totals.pages === 2, `${totals && totals.jobs} job(s), ${totals && totals.pages} page(s)`);
  ok('revenue is the amount the machine actually charged', totals.revenue === 3, `₹${totals && totals.revenue}`);
  ok('expenses are the live ones, deletions and all', totals.expenses === 4200, `₹${totals && totals.expenses} (2400 + 1800)`);
  ok('net is revenue minus expenses', totals.net === -4197, `₹${totals && totals.net}`);
  ok('revenue is attributed to the printer that earned it',
    report.payload.byPrinter.length === 1 && report.payload.byPrinter[0].printerId === mine.id,
    report.payload.byPrinter.map(p => `${p.name} ₹${p.revenue}`).join(', '));
  ok('expenses are grouped by category',
    report.payload.byCategory.length === 2 && report.payload.byCategory.every(c => c.amount > 0),
    report.payload.byCategory.map(c => `${c.category} ₹${c.amount}`).join(', '));
  ok('the day rows carry both sides of the ledger',
    report.payload.byDay.some(d => d.revenue > 0) && report.payload.byDay.some(d => d.expenses > 0),
    report.payload.byDay.map(d => d.date).join(', '));

  const csv = await req(`${SS}/reports.csv?from=2026-09-01`, { cookie: shop.cookie });
  ok('the CSV is the same report, flattened',
    csv.status === 200 && /^date,jobs,pages,revenue,expenses,net,currency/m.test(String(csv.payload)) && /total,/.test(String(csv.payload)),
    `${csv.type}`);
  const raw = await fetch(`${BASE}${SS}/reports.csv?from=2026-09-01`, { headers: { cookie: shop.cookie } });
  const disposition = raw.headers.get('content-disposition') || '';
  ok('the CSV arrives as a file, not as a page', /attachment/.test(disposition) && /\.csv/.test(disposition), disposition);

  return finish();
}

function finish() {
  return cleanup().then(async () => {
    console.log(failures === 0 ? `\n  SHOP PASS — ${checks}/${checks} checks\n` : `\n  SHOP FAILED — ${failures} of ${checks} checks\n`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
}

async function cleanup() {
  const removed = [];
  for (const id of created.jobIds) {
    // eslint-disable-next-line no-await-in-loop
    await req(`${GS}/jobs/${id}`, { method: 'DELETE', device: DEVICE }).catch(() => {});
  }
  for (const id of created.printerIds) {
    // eslint-disable-next-line no-await-in-loop
    await req(`${AS}/printers/${id}`, { method: 'DELETE', cookie: cookieForCleanup() }).catch(() => {});
  }
  for (const id of created.accountIds) {
    // eslint-disable-next-line no-await-in-loop
    const res = await req(`${OS}/accounts/${id}`, { method: 'DELETE', key: OPERATOR_KEY }).catch(() => null);
    if (res && res.status === 200) removed.push(id);
  }
  if (created.jobIds.length || created.printerIds.length || created.accountIds.length) {
    console.log(`  • cleaned up ${created.jobIds.length} job(s), ${created.printerIds.length} printer(s), ${removed.length}/${created.accountIds.length} account(s)`);
  }
  return removed;
}

/* The machine cookie is used for cleanup; grab it once, lazily. */
let machineCookie = null;
function cookieForCleanup() {
  return machineCookie || '';
}

(async () => {
  if (PASSWORD) {
    try {
      const res = await fetch(`${BASE}${AS}/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ADMIN_USER, password: PASSWORD }),
      });
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
      machineCookie = String(set.filter(Boolean)[0] || '').split(';')[0] || '';
    } catch { /* cleanup is best-effort */ }
  }
  try {
    await main();
  } catch (error) {
    console.error(`\n  shop smoke could not finish: ${error.message}\n`);
    failures += 1;
    await cleanup().catch(() => {});
    console.log(`\n  SHOP FAILED — ${failures} of ${checks} checks\n`);
    process.exitCode = 1;
  }
})();
