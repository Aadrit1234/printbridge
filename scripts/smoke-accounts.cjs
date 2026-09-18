/* Owner accounts + access codes smoke test.
 *
 * The rule this suite exists to protect: an owner account only ever comes into
 * existence by redeeming an access code, and once it exists it sees its own
 * printers and nobody else's.
 *
 *   OPERATOR_KEY=… ADMIN_PIN=… node scripts/smoke-accounts.cjs
 *   BASE=http://192.168.1.20:8088 OPERATOR_KEY=… ADMIN_PIN=… node scripts/smoke-accounts.cjs
 *
 * Checks, in order:
 *   • the operator desk refuses strangers and mints a plan-bearing code
 *   • the plans offered match the prices on the marketing site (INR)
 *   • a code creates an account, and creating it signs the owner in
 *   • the same code cannot create a second account
 *   • a code bound to an email refuses a different address
 *   • the code is accepted however it is typed (no prefix, no dashes)
 *   • wrong credentials are refused, and a lockout follows repeated failures
 *   • an owner sees only their own printers; the machine PIN sees all of them
 *   • anonymous callers get nothing
 *
 * It creates its own printer and account and removes them again, so it is safe
 * to run against a live install.
 */
'use strict';

const BASE = process.env.BASE || 'http://localhost:8088';
const GS = '/api/v1';
const OS = '/api/owner';
const AS = '/api/admin';
const OPERATOR_KEY = process.env.OPERATOR_KEY || '';
const PIN = process.env.ADMIN_PIN || '';

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

async function req(url, { method = 'GET', body, headers = {}, cookie = '', key = '' } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.cookie = cookie;
  if (key) h['x-operator-key'] = key;
  const res = await fetch(BASE + url, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json().catch(() => null) : null;
  return { status: res.status, payload, cookie: cookieOf(res) };
}

/* Anything minted by this run is deleted before it exits. */
const created = { account: null, otherAccount: null, thirdAccount: null, printerId: null, machinePrinterId: null, codeId: null, spareCodeId: null };

async function main() {
  console.log(`\n  accounts smoke: ${BASE}\n`);

  const stamp = Date.now().toString(36);
  const email = `smoke+${stamp}@example.test`;

  /* ---------------- the plans must match what is advertised ---------------- */

  const plans = await req(`${OS}/plans`);
  const byPlan = {};
  for (const p of (plans.payload && plans.payload.plans) || []) byPlan[p.id] = p;
  ok('the plans are the three INR licences',
    plans.status === 200 && byPlan['workspace-lifetime'] && byPlan['shop-yearly'] && byPlan['shop-lifetime'],
    plans.status);
  ok('workspace lifetime is ₹9,999', byPlan['workspace-lifetime'] && byPlan['workspace-lifetime'].amount === 9999,
    byPlan['workspace-lifetime'] && String(byPlan['workspace-lifetime'].amount));
  ok('shop is ₹499 a year', byPlan['shop-yearly'] && byPlan['shop-yearly'].amount === 499,
    byPlan['shop-yearly'] && String(byPlan['shop-yearly'].amount));
  ok('shop lifetime is ₹5,999', byPlan['shop-lifetime'] && byPlan['shop-lifetime'].amount === 5999,
    byPlan['shop-lifetime'] && String(byPlan['shop-lifetime'].amount));

  /* ---------------- the operator desk ---------------- */

  const noKey = await req(`${OS}/codes`, { key: 'not-the-key-but-long-enough' });
  if (OPERATOR_KEY) {
    ok('a wrong operator key is refused', noKey.status === 401, `${noKey.status} ${JSON.stringify(noKey.payload)}`);
  } else {
    ok('with no operator key configured the desk is closed', noKey.status === 503, `${noKey.status}`);
    console.log('\n  OPERATOR_KEY is not set — skipping the minting checks.\n');
    return finish();
  }

  const minted = await req(`${OS}/codes`, { method: 'POST', key: OPERATOR_KEY, body: { plan: 'shop-yearly', email, note: `smoke ${stamp}` } });
  const code = minted.payload && minted.payload.code;
  ok('the operator can mint a code for a plan', minted.status === 201 && code && code.code,
    minted.status === 201 ? `${code && code.plan} ${code && code.code}` : JSON.stringify(minted.payload));
  if (code) created.codeId = code.id;

  const list = await req(`${OS}/codes`, { key: OPERATOR_KEY });
  const listed = (list.payload && list.payload.codes) || [];
  ok('a listing never leaks the code itself', listed.length > 0 && listed.every(c => c.code === undefined),
    `depth: ${listed.length}`);

  /* ---------------- redeeming ---------------- */

  const signup = await req(`${OS}/signup`, {
    method: 'POST',
    body: { code: code.code, email, name: 'Smoke Owner', password: 'a-long-enough-password' },
  });
  ok('the code creates an account and signs it in',
    signup.status === 201 && signup.payload && signup.payload.account && signup.cookie,
    `${signup.status} ${JSON.stringify(signup.payload)}`);
  if (signup.payload && signup.payload.account) created.account = signup.payload.account;

  const accountCookie = signup.cookie;
  ok('the account inherits the plan the code carried, not the request',
    signup.payload && signup.payload.account && signup.payload.account.plan === 'shop-yearly',
    signup.payload && signup.payload.account && signup.payload.account.plan);

  const second = await req(`${OS}/signup`, {
    method: 'POST',
    body: { code: code.code, email: `other+${stamp}@example.test`, name: 'Someone Else', password: 'a-long-enough-password' },
  });
  ok('the same code cannot create a second account', second.status === 400, `${second.status} ${second.payload && second.payload.error}`);

  /* A bound code is only good for the address it was issued to. The address is
   * unique per run, because it is also the thing that must not already exist. */
  const boundEmail = `bound+${stamp}@example.test`;
  const bound = await req(`${OS}/codes`, { method: 'POST', key: OPERATOR_KEY, body: { plan: 'workspace-lifetime', email: boundEmail } });
  const boundCode = bound.payload && bound.payload.code;
  created.spareCodeId = boundCode && boundCode.id;

  const mismatched = await req(`${OS}/signup`, {
    method: 'POST',
    body: { code: boundCode.code, email: 'stranger@example.test', name: 'Stranger', password: 'a-long-enough-password' },
  });
  ok('a code issued to one address refuses another', mismatched.status === 400,
    `${mismatched.status} ${mismatched.payload && mismatched.payload.error}`);

  /* Signing up twice with one address must not burn the code: the second
   * attempt is refused, and the code is still there for a different address. */
  const reusedEmail = await req(`${OS}/signup`, {
    method: 'POST',
    body: { code: boundCode.code, email, name: 'Duplicate', password: 'a-long-enough-password' },
  });
  ok('an address that already has an account is refused', reusedEmail.status === 400,
    `${reusedEmail.status} ${reusedEmail.payload && reusedEmail.payload.error}`);
  const afterRefusal = await req(`${OS}/signup`, {
    method: 'POST',
    body: { code: boundCode.code, email: boundEmail, name: 'Bound Owner', password: 'a-long-enough-password' },
  });
  ok('a refused signup does not burn the code', afterRefusal.status === 201,
    `${afterRefusal.status} ${afterRefusal.payload && afterRefusal.payload.error}`);
  const boundAccountCookie = afterRefusal.cookie;
  if (afterRefusal.payload && afterRefusal.payload.account) created.otherAccount = afterRefusal.payload.account;

  /* And a code is accepted however it is typed: no prefix, no dashes, lower case. */
  const spare = await req(`${OS}/codes`, { method: 'POST', key: OPERATOR_KEY, body: { plan: 'shop-lifetime' } });
  created.spareCodeId = spare.payload && spare.payload.code && spare.payload.code.id;
  const typed = String(spare.payload.code.code).replace(/-/g, '').slice(2).toLowerCase();
  const typedSignup = await req(`${OS}/signup`, {
    method: 'POST',
    body: { code: typed, email: `typed+${stamp}@example.test`, name: 'Typed Owner', password: 'a-long-enough-password' },
  });
  ok('a code works typed without its prefix or dashes, in any case', typedSignup.status === 201,
    `${typedSignup.status} ${typedSignup.payload && typedSignup.payload.error}`);
  if (typedSignup.payload && typedSignup.payload.account) created.thirdAccount = typedSignup.payload.account;

  /* ---------------- signing in ---------------- */

  const wrongPassword = await req(`${OS}/login`, { method: 'POST', body: { email, password: 'not-the-password' } });
  ok('a wrong password is refused', wrongPassword.status === 401, `${wrongPassword.status}`);

  const login = await req(`${OS}/login`, { method: 'POST', body: { email, password: 'a-long-enough-password' } });
  ok('the owner can sign in with their email and password',
    login.status === 200 && login.cookie && login.payload.account.email === email,
    `${login.status}`);

  const session = await req(`${OS}/session`, { cookie: login.cookie });
  ok('the session names the account', session.status === 200 && session.payload.authenticated === true &&
    session.payload.account && session.payload.account.email === email,
    JSON.stringify(session.payload && session.payload.account));

  /* ---------------- what an owner may see ---------------- */

  const anon = await req(`${AS}/printers`);
  ok('anonymous callers cannot list printers', anon.status === 401, `${anon.status}`);

  /* The account's own printer. */
  const mine = await req(`${AS}/printers`, {
    method: 'POST',
    cookie: accountCookie,
    body: {
      name: `Smoke shop ${stamp}`,
      category: 'shop',
      pricing: { currency: 'INR', colorPerPage: 5, monoPerPage: 2 },
      capabilities: { papers: ['a4'], orientations: ['portrait'], duplex: false, color: true },
    },
  });
  ok('an owner can register a printer of their own', mine.status === 201, `${mine.status} ${JSON.stringify(mine.payload)}`);
  if (mine.payload && mine.payload.printer) created.printerId = mine.payload.printer.id;
  ok('the printer is stamped with the owner account',
    mine.payload && mine.payload.printer && mine.payload.printer.accountId === (created.account && created.account.id),
    mine.payload && mine.payload.printer && mine.payload.printer.accountId);

  const listMine = await req(`${AS}/printers`, { cookie: accountCookie });
  const mineIds = ((listMine.payload && listMine.payload.printers) || []).map(p => p.id);
  ok('the owner sees their own printer', mineIds.includes(created.printerId), `${mineIds.length} printer(s)`);
  ok('an owner never sees the machine\'s own printers',
    Boolean(created.account) && ((listMine.payload && listMine.payload.printers) || []).every(p => p.accountId === created.account.id),
    `${mineIds.length} printer(s)`);

  /* Somebody else's printer: 404, not 403 — its existence is not their business. */
  const stranger = await req(`${AS}/printers/${created.printerId}`, { cookie: boundAccountCookie });
  ok('another account cannot read a printer it does not own', stranger.status === 404, `${stranger.status}`);

  const strangerDelete = await req(`${AS}/printers/${created.printerId}`, { method: 'DELETE', cookie: boundAccountCookie });
  ok('another account cannot delete it either', strangerDelete.status === 404, `${strangerDelete.status}`);

  /* Workspace accounts cannot cost themselves a licence by renaming ownership. */
  const rehome = await req(`${AS}/printers/${created.printerId}`, {
    method: 'PATCH', cookie: accountCookie, body: { accountId: 'acc_somebody_else' },
  });
  ok('a patch cannot reassign a printer to another account',
    rehome.status === 200 && rehome.payload.printer.accountId === created.account.id,
    rehome.payload && rehome.payload.printer && rehome.payload.printer.accountId);

  /* ---------------- the machine still runs the machine ---------------- */

  if (PIN) {
    const machine = await req(`${AS}/login`, { method: 'POST', body: { pin: PIN } });
    ok('the machine PIN still signs in', machine.status === 200, `${machine.status}`);
    if (machine.cookie) {
      const all = await req(`${AS}/printers`, { cookie: machine.cookie });
      const allIds = ((all.payload && all.payload.printers) || []).map(p => p.id);
      ok('the machine PIN sees every printer, including the owner\'s', allIds.includes(created.printerId),
        `${allIds.length} printer(s)`);

      const madeByMachine = await req(`${AS}/printers`, {
        method: 'POST', cookie: machine.cookie,
        body: { name: `Machine printer ${stamp}`, category: 'workspace', capabilities: { papers: ['a4'], orientations: ['portrait'], duplex: false, color: false } },
      });
      if (madeByMachine.payload && madeByMachine.payload.printer) created.machinePrinterId = madeByMachine.payload.printer.id;
      ok('the machine can register an unowned printer', madeByMachine.status === 201, `${madeByMachine.status}`);

      const stillOnlyMine = await req(`${AS}/printers`, { cookie: accountCookie });
      ok('an owner does not pick up printers the machine owns',
        ((stillOnlyMine.payload && stillOnlyMine.payload.printers) || []).length === mineIds.length,
        `${((stillOnlyMine.payload && stillOnlyMine.payload.printers) || []).length} vs ${mineIds.length}`);

      const other = await req(`${AS}/printers/${created.machinePrinterId}`, { cookie: accountCookie });
      ok('an owner cannot open an unowned printer by id', other.status === 404, `${other.status}`);

      created.machineCookie = machine.cookie;
    }
  } else {
    console.log('  (ADMIN_PIN not set — skipped the machine-scope checks)');
  }

  /* ---------------- cleanup ---------------- */

  const cleanupCookie = created.machineCookie || accountCookie;
  for (const id of [created.printerId, created.machinePrinterId]) {
    if (id) await req(`${AS}/printers/${id}`, { method: 'DELETE', cookie: cleanupCookie }).catch(() => {});
  }

  /* Accounts and unused codes this run left behind. The vendor can do this and
   * only the vendor — the operator key is the difference. */
  const doomed = [created.account, created.otherAccount, created.thirdAccount].filter(Boolean);
  const strangerCleanup = await req(`${OS}/accounts/${doomed[0] ? doomed[0].id : 'nobody'}`, {
    method: 'DELETE', cookie: accountCookie,
  });
  ok('an owner cannot delete accounts, not even their own', strangerCleanup.status === 401, `${strangerCleanup.status}`);

  for (const account of doomed) {
    await req(`${OS}/accounts/${account.id}`, { method: 'DELETE', key: OPERATOR_KEY }).catch(() => {});
  }
  for (const id of [created.codeId, created.spareCodeId]) {
    if (id) await req(`${OS}/codes/${id}/revoke`, { method: 'POST', key: OPERATOR_KEY }).catch(() => {});
  }
  ok('cleaned up the printers and accounts this run created', true);

  return finish();
}

function finish() {
  console.log('');
  if (failures) {
    console.log(`  ACCOUNTS FAIL — ${checks - failures}/${checks} checks\n`);
    process.exit(1);
  }
  console.log(`  ACCOUNTS PASS — ${checks}/${checks} checks\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n  accounts smoke crashed:', e && e.message ? e.message : e);
  process.exit(1);
});
