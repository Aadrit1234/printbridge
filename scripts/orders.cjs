'use strict';
/* The order desk, from a terminal.
 *
 *   node scripts/orders.cjs                 every order, newest first, with takings
 *   node scripts/orders.cjs show <order>    one order in full
 *   node scripts/orders.cjs paid <order> [ref]   the money arrived → mint + email the code
 *   node scripts/orders.cjs resend <order>  send the licence email again
 *   node scripts/orders.cjs cancel <order> [why]
 *   node scripts/orders.cjs forget <order>  take it out of the ledger, code and all
 *
 * A buyer pays by UPI (or however PAYMENT_* says), tells you the order number,
 * and you run `paid` on it. That one command decides the plan from the order,
 * mints a code for it, binds it to the buyer's address and sends the mail —
 * so there is no step to forget halfway.
 *
 * Needs the server running and OPERATOR_KEY set (the same key the desk uses):
 *
 *   BASE=http://localhost:8088 OPERATOR_KEY=… node scripts/orders.cjs paid PB-2026-0001
 */

const BASE = process.env.BASE || 'http://localhost:8088';
const KEY = process.env.OPERATOR_KEY || '';

const money = (amount, currency) => `${currency === 'INR' ? '\u20B9' : `${currency} `}${Number(amount).toLocaleString('en-IN')}`;

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + '/api/owner' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-operator-key': KEY },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((payload && payload.error) || `HTTP ${res.status}`);
    err.payload = payload;
    throw err;
  }
  return payload;
}

function line(o) {
  const paid = o.status === 'paid' ? 'paid' : o.status;
  const when = (o.paidAt || o.createdAt || '').slice(0, 16).replace('T', ' ');
  return [
    o.number.padEnd(13),
    paid.padEnd(9),
    `${o.planLabel} ${o.term}`.padEnd(20),
    money(o.amount, o.currency).padStart(8),
    o.email.padEnd(28),
    when,
  ].join(' ');
}

async function main() {
  const [command = 'list', id, extra] = process.argv.slice(2);

  if (!KEY) {
    console.error('\n  Set OPERATOR_KEY (the same one in .env) to use the order desk.\n');
    process.exit(2);
  }

  if (command === 'list' || command === 'ls') {
    const { orders, stats, payment, mail } = await call('/orders');
    if (!orders.length) {
      console.log('\n  No orders yet. They appear here the moment somebody checks out on the site.\n');
      return;
    }
    console.log(`\n  ${orders.length} order(s) at ${BASE}\n`);
    console.log('  ' + 'ORDER'.padEnd(13) + 'STATUS'.padEnd(9) + 'LICENCE'.padEnd(20) + 'AMOUNT'.padStart(8) + '  EMAIL'.padEnd(30) + 'WHEN');
    for (const o of orders) console.log('  ' + line(o));
    console.log(`\n  paid ${stats.paid} · pending ${stats.pending} · cancelled ${stats.cancelled}`);
    console.log(`  takings ${money(stats.takings, stats.currency)}  (workspace ${stats.licences.workspace}, shop ${stats.licences.shop})`);
    console.log(`  payment: ${payment.configured ? (payment.upi ? `UPI ${payment.upi} (${payment.payee})` : 'bank transfer') : 'not configured — set PAYMENT_UPI in .env'}`);
    console.log(`  mail: ${mail.configured ? `sending via ${mail.provider}` : `no provider set — licence emails are written to data/mail-outbox (${mail.outbox.length} waiting)`}\n`);
    return;
  }

  if (command === 'show') {
    if (!id) throw new Error('show needs an order number, e.g. PB-2026-0001');
    const order = (await call('/orders')).orders.find(o => o.id === id || o.number === id);
    if (!order) throw new Error(`No order ${id}`);
    console.log('');
    for (const [k, v] of Object.entries(order)) {
      if (v === null || v === '' || k === 'id') continue;
      const value = k === 'address' ? [v.line1, v.line2, v.city, v.state, v.pincode, v.country].filter(Boolean).join(', ') : v;
      console.log(`  ${k.padEnd(12)} ${value}`);
    }
    console.log('');
    return;
  }

  if (command === 'paid') {
    if (!id) throw new Error('paid needs an order number, e.g. PB-2026-0001');
    const res = await call(`/orders/${id}/paid`, { method: 'POST', body: { reference: extra || null } });
    console.log(`\n  ${res.order.number} marked paid — ${res.order.planLabel} ${res.order.term}, ${money(res.order.amount, res.order.currency)}\n`);
    console.log(`  access code  ${res.code}\n`);
    if (res.mailError) {
      console.log(`  the licence email FAILED: ${res.mailError}`);
      console.log('  the copy is in data/mail-outbox — send it from there, or fix mail and run `resend`.\n');
    } else if (res.mail && res.mail.sent) {
      console.log(`  licence email sent to ${res.order.email} via ${res.mail.via}\n`);
    } else {
      console.log(`  no mail provider set — the email is waiting at ${res.mail && res.mail.file}\n`);
      console.log('  (set MAIL_API_KEY + MAIL_FROM, or MAIL_WEBHOOK_URL, in .env to send it for real)\n');
    }
    return;
  }

  if (command === 'resend') {
    if (!id) throw new Error('resend needs an order number');
    const res = await call(`/orders/${id}/resend`, { method: 'POST' });
    console.log(`\n  resent ${res.order.number} to ${res.order.email} via ${res.mail.via}\n`);
    return;
  }

  if (command === 'cancel') {
    if (!id) throw new Error('cancel needs an order number');
    const res = await call(`/orders/${id}/cancel`, { method: 'POST', body: { reason: extra || '' } });
    console.log(`\n  ${res.order.number} cancelled\n`);
    return;
  }

  if (command === 'forget') {
    if (!id) throw new Error('forget needs an order number');
    const res = await call(`/orders/${id}`, { method: 'DELETE' });
    console.log(`\n  order removed${res.codeRemoved ? ' — its access code went with it' : ''}\n`);
    return;
  }

  throw new Error(`Unknown command "${command}" — try list, show, paid, resend, cancel or forget`);
}

main().catch((e) => {
  console.error(`\n  ${e.message}\n`);
  process.exit(1);
});
