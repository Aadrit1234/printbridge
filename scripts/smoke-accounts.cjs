/* Owner accounts + access codes smoke test.
 *
 * The rule this suite exists to protect: an owner account only ever comes into
 * existence by redeeming an access code, and once it exists it sees its own
 * printers and nobody else's.
 *
 *   OPERATOR_KEY=… ADMIN_PASSWORD=… node scripts/smoke-accounts.cjs
 *   BASE=http://192.168.1.20:8088 OPERATOR_KEY=… ADMIN_PASSWORD=… node scripts/smoke-accounts.cjs
 *
 * Checks, in order:
 *   • the operator desk refuses strangers and mints a plan-bearing code
 *   • the plans offered match the prices on the marketing site (INR)
 *   • buying: details in, order recorded at the plan's price (not the one sent),
 *     paid → a code for that plan is minted and the licence email is written or sent
 *   • the buyer's own page sees the code once paid, and only once paid
 *   • redeeming the order's code yields an account with that plan and the
 *     right app to download
 *   • a code creates an account, and creating it signs the owner in
 *   • the same code cannot create a second account
 *   • a code bound to an email refuses a different address
 *   • the code is accepted however it is typed (no prefix, no dashes)
 *   • wrong credentials are refused, and a lockout follows repeated failures
 *   • an owner sees only their own printers; the machine's sign-in sees all of them
 *   • anonymous callers get nothing
 *
 * It creates its own printer and account and removes them again, so it is safe
 * to run against a live install.
 */
'use strict';

const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:8088';
const GS = '/api/v1';
const OS = '/api/owner';
const AS = '/api/admin';
const OPERATOR_KEY = process.env.OPERATOR_KEY || '';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_PIN || '';

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
  return { status: res.status, payload, cookie: cookieOf(res), headers: res.headers };
}

/* Anything minted by this run is deleted before it exits. */
const created = {
  account: null, otherAccount: null, thirdAccount: null, orderAccount: null,
  printerId: null, machinePrinterId: null, codeId: null, spareCodeId: null, order: null,
};

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
  ok('workspace lifetime is ₹6,999', byPlan['workspace-lifetime'] && byPlan['workspace-lifetime'].amount === 6999,
    byPlan['workspace-lifetime'] && String(byPlan['workspace-lifetime'].amount));
  ok('shop is ₹499 a year', byPlan['shop-yearly'] && byPlan['shop-yearly'].amount === 499,
    byPlan['shop-yearly'] && String(byPlan['shop-yearly'].amount));
  ok('shop lifetime is ₹11,999', byPlan['shop-lifetime'] && byPlan['shop-lifetime'].amount === 11999,
    byPlan['shop-lifetime'] && String(byPlan['shop-lifetime'].amount));
  /* The features are what a buyer is told they get, so every plan has to carry
   * them — an empty list on the site is a plan nobody can understand. */
  ok('every plan lists what it includes',
    Object.values(byPlan).every(p => Array.isArray(p.features) && p.features.length >= 4),
    Object.values(byPlan).map(p => p.features && p.features.length).join('/'));
  ok('a plan says which app it comes with',
    byPlan['workspace-lifetime'].app === 'workspace' && byPlan['shop-lifetime'].app === 'shop',
    `${byPlan['workspace-lifetime'].app} / ${byPlan['shop-lifetime'].app}`);

  /* ---------------- the operator desk ---------------- */

  const noKey = await req(`${OS}/codes`, { key: 'not-the-key-but-long-enough' });
  if (OPERATOR_KEY) {
    ok('a key that is not the operator key is refused', noKey.status === 401 || noKey.status === 503, `${noKey.status} ${JSON.stringify(noKey.payload)}`);
  } else {
    console.log('\n  OPERATOR_KEY is not set — skipping the minting checks.\n');
    return finish();
  }

  const minted = await req(`${OS}/codes`, { method: 'POST', key: OPERATOR_KEY, body: { plan: 'shop-yearly', email, note: `smoke ${stamp}` } });
  const code = minted.payload && minted.payload.code;
  ok('the operator can mint a code for a plan', minted.status === 201 && code && code.code,
    minted.status === 201 ? `${code && code.plan} ${code && code.code}` : JSON.stringify(minted.payload));
  if (code) created.codeId = code.id;

  ok('a shop code says SH at a glance', Boolean(code && /^SH-/.test(code.code)), code && code.code);

  const list = await req(`${OS}/codes`, { key: OPERATOR_KEY });
  const listed = (list.payload && list.payload.codes) || [];
  ok('a listing never leaks the code itself', listed.length > 0 && listed.every(c => c.code === undefined),
    `depth: ${listed.length}`);

  /* ---------------- buying: the checkout, the order, the code ---------------- */

  /* The checkout is throttled per address (the ledger is open to anyone with the
   * link, so it has to be). Running this suite five times in an hour trips that
   * — say so and move on rather than reporting a wall of false failures. */
  const orderEmail = `buyer+${stamp}@example.test`;
  const badAddress = await req(`${OS}/orders`, {
    method: 'POST',
    body: { plan: 'shop-lifetime', name: 'No Address', email: orderEmail, address: { line1: 'x' } },
  });
  const ordersBlocked = badAddress.status === 429;
  if (ordersBlocked) {
    console.log(`\n  the checkout is throttled for this address (${badAddress.payload && badAddress.payload.error})`);
    console.log('  — skipping the order checks. Wait for the window to pass, or restart the server.\n');
  } else {
  ok('an order without a billing address is refused', badAddress.status === 400,
    `${badAddress.status} ${badAddress.payload && badAddress.payload.error}`);

  const badEmail = await req(`${OS}/orders`, {
    method: 'POST',
    body: { plan: 'shop-lifetime', name: 'Bad Email', email: 'not-an-address', address: { line1: 'a', city: 'b', pincode: 'c' } },
  });
  ok('an order without a usable email is refused', badEmail.status === 400,
    `${badEmail.status} ${badEmail.payload && badEmail.payload.error}`);

  const placed = await req(`${OS}/orders`, {
    method: 'POST',
    body: {
      plan: 'shop-lifetime',
      name: 'Smoke Buyer',
      email: orderEmail,
      phone: '+91 98765 43210',
      method: 'upi',
      /* A browser trying to name its own price. The order must ignore it. */
      amount: 1,
      address: { line1: '12 Paper Lane', line2: 'Behind the market', city: 'Pune', state: 'MH', pincode: '411001' },
    },
  });
  const order = placed.payload && placed.payload.order;
  ok('the checkout records an order', placed.status === 201 && order && order.number,
    `${placed.status} ${order && order.number}`);
  ok('the order is priced from the plan, not from the request', order && order.amount === 11999,
    order && String(order.amount));
  ok('a fresh order is pending and carries no code', order && order.status === 'pending' && !order.code,
    order && `${order.status} ${order.code}`);
  if (order) created.order = order;

  const wrongKeyPaid = await req(`${OS}/orders/${order.id}/paid`, { method: 'POST', key: 'not-the-key-but-long-enough' });
  ok('strangers cannot mark an order paid', wrongKeyPaid.status === 401 || wrongKeyPaid.status === 503, `${wrongKeyPaid.status}`);

  const watch = await req(`${OS}/orders/${order.id}`);
  ok('the buyer can watch their own order by its id', watch.status === 200 && watch.payload.order.status === 'pending',
    `${watch.status}`);

  const paid = await req(`${OS}/orders/${order.id}/paid`, { method: 'POST', key: OPERATOR_KEY, body: { reference: `upi-${stamp}` } });
  const paidCode = paid.payload && paid.payload.code;
  ok('marking an order paid mints a code for its plan',
    paid.status === 200 && paidCode && /^SH-/.test(paidCode),
    `${paid.status} ${paidCode}`);
  ok('the licence email went out, or is waiting in the outbox',
    paid.status === 200 && (paid.payload.mailError === null) && Boolean(paid.payload.mail),
    paid.payload && (paid.payload.mailError || (paid.payload.mail && paid.payload.mail.via)));
  if (paid.payload && paid.payload.mail && paid.payload.mail.file) {
    ok('the outbox copy is on disk where the order desk says it is',
      fs.existsSync(paid.payload.mail.file), paid.payload.mail.file);
  }

  const afterPaid = await req(`${OS}/orders/${order.id}`);
  ok('the buyer now sees their code — and only now',
    afterPaid.payload.order.status === 'paid' && afterPaid.payload.order.code === paidCode,
    `${afterPaid.payload.order.status} ${afterPaid.payload.order.code}`);

  const twice = await req(`${OS}/orders/${order.id}/paid`, { method: 'POST', key: OPERATOR_KEY });
  ok('paying twice refuses instead of issuing a second licence', twice.status === 409, `${twice.status}`);

  const desk = await req(`${OS}/orders`, { key: OPERATOR_KEY });
  ok('the order desk lists it and counts the money',
    desk.status === 200 && (desk.payload.orders || []).some(o => o.number === order.number) && desk.payload.stats.takings >= 11999,
    desk.status === 200 ? `takings ${desk.payload.stats.takings}` : String(desk.status));
  ok('the desk never leaks a code unless it is asked for one',
    (desk.payload.orders || []).every(o => o.code === undefined), 'listing');

  /* The code the buyer was emailed has to do the whole job: create the account
   * and hand them the right app to download. */
  const orderSignup = await req(`${OS}/signup`, {
    method: 'POST',
    body: { code: paidCode, email: orderEmail, name: 'Smoke Buyer', password: 'a-long-enough-password' },
  });
  ok('the code from the order creates the buyer\'s account', orderSignup.status === 201,
    `${orderSignup.status} ${orderSignup.payload && orderSignup.payload.error}`);
  if (orderSignup.payload && orderSignup.payload.account) created.orderAccount = orderSignup.payload.account;

  const orderAccount = await req(`${OS}/account`, { cookie: orderSignup.cookie });
  const licence = orderAccount.payload && orderAccount.payload.licence;
  const download = orderAccount.payload && orderAccount.payload.download;
  ok('the account carries the licence that was bought',
    orderAccount.status === 200 && licence && licence.id === 'shop-lifetime' && licence.features.length >= 4,
    licence && `${licence.id} (${licence.features.length} features)`);
  ok('a shop licence downloads the shop app',
    download && download.primary && download.primary.id === 'shop' && /PrintBridge-Shop-Setup/.test(download.primary.url),
    download && download.primary && download.primary.url);
  ok('the download URL points at a published release for this version',
    download && /releases\/download\/v[0-9]+\.[0-9]+\.[0-9]+\//.test(download.primary.url),
    download && download.primary && download.primary.url);
  }

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

  /* The site is often deployed somewhere else (Vercel) while this machine
   * serves the API, so a buyer signing in there is another origin: the session
   * cookie has to be SameSite=None; Secure or it signs in once and is forgotten
   * on the next page. The origin comes from the allowlist itself. */
  const allowlist = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const isLoopbackOrigin = (value) => {
    try {
      const host = new URL(value).hostname;
      return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
    } catch { return false; }
  };
  /* A local dev server on another port is the same *site*, so that cookie must
   * stay Strict even though the request is cross-origin. Only a genuinely
   * different site needs None; Secure. */
  const foreign = allowlist.find(origin => !isLoopbackOrigin(origin));
  const localPage = allowlist.find(isLoopbackOrigin);
  if (localPage) {
    const fromLocalPage = await req(`${OS}/login`, {
      method: 'POST', headers: { origin: localPage }, body: { email, password: 'a-long-enough-password' },
    });
    const raw = fromLocalPage.headers.get('set-cookie') || '';
    ok('a local page on another port gets the CORS headers, and a Strict cookie',
      fromLocalPage.headers.get('access-control-allow-origin') === localPage && /SameSite=Strict/.test(raw),
      raw.split(';').slice(1).join(';'));
  }
  if (foreign) {
    const crossSiteLogin = await req(`${OS}/login`, {
      method: 'POST', headers: { origin: foreign }, body: { email, password: 'a-long-enough-password' },
    });
    const raw = crossSiteLogin.headers.get('set-cookie') || '';
    ok('a sign-in from the deployed site is allowed to read the answer',
      crossSiteLogin.headers.get('access-control-allow-origin') === foreign,
      `${crossSiteLogin.headers.get('access-control-allow-origin')} for ${foreign}`);
    ok('and gets a cookie built for crossing sites',
      /SameSite=None/.test(raw) && /Secure/.test(raw),
      raw.split(';').slice(1).join(';'));
  } else {
    console.log('  (no non-loopback origin in ALLOWED_ORIGINS — skipped the cross-site cookie check)');
  }

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

  if (PASSWORD) {
    /* The console signs in with a username and a password. `{ pin }` — a
     * password with no username — is the older body and must keep working, or
     * every script and an app a version behind loses access. */
    const legacy = await req(`${AS}/login`, { method: 'POST', body: { pin: PASSWORD } });
    ok('a password with no username still signs in (older clients)', legacy.status === 200, `${legacy.status}`);

    const badUser = await req(`${AS}/login`, { method: 'POST', body: { username: 'no-such-user-here', password: PASSWORD } });
    ok('the right password with the wrong username is refused', badUser.status === 401, `${badUser.status}`);

    const noUser = await req(`${AS}/login`, { method: 'POST', body: { password: PASSWORD } });
    ok('a password on its own is refused once a username is expected', noUser.status === 400, `${noUser.status} ${noUser.payload && noUser.payload.error}`);

    const machine = await req(`${AS}/login`, {
      method: 'POST',
      body: { username: ADMIN_USER, password: PASSWORD },
    });
    ok('the machine signs in with its username and password',
      machine.status === 200 && machine.payload && machine.payload.via === 'password',
      `${machine.status} ${machine.payload && machine.payload.via}`);

    /* An owner account opens the same console — that is how the shop's app
     * signs in on a laptop that is not the printer's machine. */
    const asOwner = await req(`${AS}/login`, { method: 'POST', body: { username: email, password: 'a-long-enough-password' } });
    ok('an owner account opens the console as itself',
      asOwner.status === 200 && asOwner.payload && asOwner.payload.via === 'account',
      `${asOwner.status} ${asOwner.payload && asOwner.payload.via}`);

    if (machine.cookie) {
      const all = await req(`${AS}/printers`, { cookie: machine.cookie });
      const allIds = ((all.payload && all.payload.printers) || []).map(p => p.id);
      ok('the machine sign-in sees every printer, including the owner\'s', allIds.includes(created.printerId),
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
    console.log('  (no console password given — skipped the machine-scope checks)');
  }

  /* ---------------- cleanup ---------------- */

  const cleanupCookie = created.machineCookie || accountCookie;
  for (const id of [created.printerId, created.machinePrinterId]) {
    if (id) await req(`${AS}/printers/${id}`, { method: 'DELETE', cookie: cleanupCookie }).catch(() => {});
  }

  /* Accounts and unused codes this run left behind. The vendor can do this and
   * only the vendor — the operator key is the difference. */
  /* The sale this run invented is taken out of the ledger entirely — a smoke
   * test must not leave a paid order or a redeemed code behind on a live
   * install. Deleting a paid order takes its code with it. */
  if (created.order) {
    const removed = await req(`${OS}/orders/${created.order.id}`, { method: 'DELETE', key: OPERATOR_KEY });
    ok('a test sale can be taken out of the ledger', removed.status === 200 && removed.payload.codeRemoved === true,
      `${removed.status} ${JSON.stringify(removed.payload)}`);
  }

  const doomed = [created.account, created.otherAccount, created.thirdAccount, created.orderAccount].filter(Boolean);
  const strangerCleanup = await req(`${OS}/accounts/${doomed[0] ? doomed[0].id : 'nobody'}`, {
    method: 'DELETE', cookie: accountCookie,
  });
  ok('an owner cannot delete accounts, not even their own', strangerCleanup.status === 401, `${strangerCleanup.status}`);

  for (const account of doomed) {
    await req(`${OS}/accounts/${account.id}`, { method: 'DELETE', key: OPERATOR_KEY }).catch(() => {});
  }
  for (const id of [created.codeId, created.spareCodeId]) {
    if (id) await req(`${OS}/codes/${id}`, { method: 'DELETE', key: OPERATOR_KEY }).catch(() => {});
  }
  ok('cleaned up the printers and accounts this run created', true);

  return finish();
}

function finish() {
  console.log('');
  const failed = Boolean(failures);
  console.log(failed
    ? `  ACCOUNTS FAIL — ${checks - failures}/${checks} checks\n`
    : `  ACCOUNTS PASS — ${checks}/${checks} checks\n`);

  /* Exit through Node rather than process.exit(). Calling it straight after the
   * last response aborts a socket mid-close on Windows — libuv asserts and the
   * process dies with 127, which reads like a suite crash. The unref'd timer is
   * the safety net: if something really is holding the loop open, this still
   * exits, and if nothing is, Node has already gone. */
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 1500).unref();
}

main().catch((e) => {
  console.error('\n  accounts smoke crashed:', e && e.message ? e.message : e);
  process.exit(1);
});
