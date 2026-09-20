'use strict';
/* Orders — what somebody bought, before it becomes a licence.
 *
 * The shape of a sale:
 *
 *   1. the buyer fills in their details and picks a plan on the website
 *   2. the order is recorded here, priced from PLANS — never from the request,
 *      so the amount owed is not something a browser gets to decide
 *   3. they are shown how to pay (UPI to the shop's own id by default; a
 *      gateway can call the same "paid" step later with nothing else changing)
 *   4. the money arrives and the order is marked paid, which mints an access
 *      code for exactly the plan that was bought, binds it to the buyer's
 *      email, and mails it
 *   5. redeeming that code is what creates the account (routes/owner.js)
 *
 * The order is the paper trail: it survives the code, names who paid, how much
 * and when, and is where an invoice number comes from.
 *
 * Persisted to data/orders.json.
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger').make('orders');
const codes = require('./access-codes');
const mail = require('./mail');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[+]?[0-9][0-9\s()-]{6,19}$/;
const METHODS = ['upi', 'bank', 'gateway'];

let file = null;
let orders = [];
let counter = 0;

function env(name) { return String(process.env[name] || '').trim() || null; }

/** Where the site lives, for links in the licence email. */
function publicUrl() { return env('PUBLIC_URL') || 'https://print-pi-three.vercel.app'; }

function newId() { return `ord_${Date.now().toString(36)}${require('crypto').randomBytes(4).toString('hex')}`; }

/** PB-2026-0007: short enough to read down a phone, unique within the year. */
function nextNumber() {
  const year = new Date().getFullYear();
  counter += 1;
  return `PB-${year}-${String(counter).padStart(4, '0')}`;
}

function rebuild() {
  counter = orders.reduce((max, o) => {
    const n = parseInt(String(o.number || '').split('-')[2], 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
}

function save() {
  if (!file) return;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, counter, orders }, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    log.error(`could not write orders: ${e.message}`);
  }
}

function init(dataDir) {
  file = path.join(dataDir, 'orders.json');
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      orders = Array.isArray(parsed.orders) ? parsed.orders : [];
      counter = Number(parsed.counter) || 0;
    }
  } catch (e) {
    log.error(`orders.json is unreadable (${e.message}) — starting a fresh ledger`);
    orders = [];
  }
  rebuild();
  return module.exports;
}

/* ---------------- pricing & payment ---------------- */

/**
 * How to pay, from the environment. A shop that has not set a UPI id still
 * gets a usable answer: the site tells the buyer to contact the shop. Nothing
 * here ever invents an account number.
 */
function payment() {
  const upi = env('PAYMENT_UPI');
  const payee = env('PAYMENT_PAYEE') || 'PrintBridge';
  const bank = env('PAYMENT_BANK');
  return {
    methods: METHODS,
    upi,
    payee,
    bank,
    note: env('PAYMENT_NOTE') || null,
    configured: Boolean(upi || bank),
  };
}

/* ---------------- creating ---------------- */

function cleanAddress(input) {
  const a = input || {};
  const out = {
    line1: String(a.line1 || '').trim().slice(0, 120),
    line2: String(a.line2 || '').trim().slice(0, 120),
    city: String(a.city || '').trim().slice(0, 80),
    state: String(a.state || '').trim().slice(0, 80),
    pincode: String(a.pincode || '').trim().slice(0, 12),
    country: String(a.country || 'India').trim().slice(0, 60) || 'India',
  };
  const missing = [];
  if (!out.line1) missing.push('address');
  if (!out.city) missing.push('city');
  if (!out.pincode) missing.push('PIN code');
  if (missing.length) throw new Error(`Billing address needs a ${missing.join(', a ')}`);
  return out;
}

/**
 * Record an order. The plan decides the price and the category — the request
 * only supplies who is buying and where to bill them.
 */
function create({ plan, name, email, phone = '', address, method = 'upi', note = '', source = 'website' } = {}) {
  const key = String(plan || '').trim();
  const spec = codes.PLANS[key];
  if (!spec) throw new Error('Choose a licence before you check out');

  const who = String(name || '').trim().slice(0, 80);
  if (who.length < 2) throw new Error('Enter the name the licence should be issued to');

  const to = String(email || '').trim().toLowerCase();
  if (!EMAIL.test(to)) throw new Error('Enter a valid email address — the access code is sent there');

  const digits = String(phone || '').trim();
  if (digits && !PHONE.test(digits)) throw new Error('That phone number does not look right');

  if (!METHODS.includes(method)) throw new Error('Choose how you would like to pay');

  const order = {
    id: newId(),
    number: nextNumber(),
    plan: key,
    planLabel: spec.label,
    category: spec.category,
    term: spec.term,
    amount: spec.amount,          // from PLANS, not from the caller
    currency: spec.currency,
    name: who,
    email: to,
    phone: digits || null,
    address: cleanAddress(address),
    method,
    note: String(note || '').slice(0, 300),
    status: 'pending',
    source: String(source || 'website').slice(0, 40),
    createdAt: new Date().toISOString(),
    paidAt: null,
    reference: null,
    cancelledAt: null,
    code: null,
    codeId: null,
    mailedAt: null,
    mailVia: null,
    mailError: null,
  };

  orders.push(order);
  save();
  log.info(`order ${order.number}: ${order.plan} for ${order.email} (${order.amount} ${order.currency})`);
  return order;
}

/* ---------------- paying ---------------- */

function licenceEmail(order, code) {
  const app = order.category === 'shop' ? 'PrintBridge Shop' : 'PrintBridge Workspace';
  const site = publicUrl();
  const lines = [
    `Hello ${order.name},`,
    '',
    `Thank you for buying ${order.planLabel} (${order.term}) — order ${order.number}.`,
    '',
    `Your access code is:  ${code}`,
    '',
    'What to do with it:',
    `  1. Open ${site}/owner and choose "I have an access code".`,
    '  2. Enter this code, your name, this email address and a password.',
    `  3. That creates your account, and the page then offers ${app} to download.`,
    '',
    'The code works once, and it is the only thing that can create the account:',
    'keep it to yourself until the account exists. If you lose it before then,',
    'reply to this email and we will reissue it.',
    '',
  ];
  if (order.address && order.address.city) {
    lines.push(`Billed to: ${order.name}, ${order.address.line1}${order.address.line2 ? `, ${order.address.line2}` : ''}, ${order.address.city} ${order.address.pincode}, ${order.address.country}`);
    lines.push('');
  }
  lines.push(`Amount: ${order.currency === 'INR' ? 'Rs.' : order.currency} ${order.amount.toLocaleString('en-IN')} (${order.term})`);
  lines.push('');
  lines.push('— PrintBridge');
  return lines.join('\n');
}

/**
 * Mark an order paid, mint its code and mail it. Idempotent in the sense that
 * matters: an order that is already paid refuses rather than issuing a second
 * licence for one payment.
 */
async function markPaid(id, { reference = null, by = 'operator' } = {}) {
  const order = get(id);
  if (!order) throw new Error('No such order');
  if (order.status === 'cancelled') throw new Error('That order was cancelled');
  if (order.status === 'paid') {
    const err = new Error(`Order ${order.number} is already paid`);
    err.status = 409;
    err.order = order;
    throw err;
  }

  const entry = codes.mint({ plan: order.plan, email: order.email, note: order.number });
  order.status = 'paid';
  order.paidAt = new Date().toISOString();
  order.reference = reference ? String(reference).slice(0, 120) : null;
  order.code = entry.code;
  order.codeId = entry.id;
  order.mailError = null;
  save();
  log.info(`order ${order.number} paid (by ${by}) — code minted`);

  let result = null;
  try {
    result = await mail.send({
      to: order.email,
      subject: `Your PrintBridge access code — order ${order.number}`,
      text: licenceEmail(order, entry.code),
    });
    order.mailedAt = new Date().toISOString();
    order.mailVia = result.via;
  } catch (e) {
    /* The customer paid; the code exists. Say the mail failed rather than
     * pretending otherwise, and keep the copy so it can be resent. */
    order.mailError = e.message;
  }
  save();

  return { order, code: entry.code, mail: result, mailError: order.mailError };
}

/** Send the licence email again, for an order that is already paid. */
async function resend(id) {
  const order = get(id);
  if (!order) throw new Error('No such order');
  if (order.status !== 'paid' || !order.code) throw new Error('That order has not been paid yet');
  const result = await mail.send({
    to: order.email,
    subject: `Your PrintBridge access code — order ${order.number}`,
    text: licenceEmail(order, order.code),
  });
  order.mailedAt = new Date().toISOString();
  order.mailVia = result.via;
  order.mailError = null;
  save();
  return { order, mail: result };
}

/**
 * Take an order out of the ledger entirely. Vendor-only, and for support: a
 * test sale, a duplicate submit, somebody who asked for their details gone. A
 * paid order is not removed silently — its code is revoked by the caller first,
 * which is the order desk's `forget`.
 */
function remove(id) {
  const index = orders.findIndex(o => o.id === id || o.number === id);
  if (index === -1) return null;
  const [order] = orders.splice(index, 1);
  save();
  log.warn(`order ${order.number} removed from the ledger`);
  return order;
}

function cancel(id, { reason = '' } = {}) {
  const order = get(id);
  if (!order) throw new Error('No such order');
  if (order.status === 'paid') throw new Error('That order is paid — revoke the access code instead');
  order.status = 'cancelled';
  order.cancelledAt = new Date().toISOString();
  order.note = [order.note, reason].filter(Boolean).join(' · ').slice(0, 300);
  save();
  log.warn(`order ${order.number} cancelled${reason ? `: ${reason}` : ''}`);
  return order;
}

/* ---------------- reading ---------------- */

function get(id) { return orders.find(o => o.id === id || o.number === id) || null; }
function all() { return orders.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }

function view(o) {
  return {
    id: o.id,
    number: o.number,
    plan: o.plan,
    planLabel: o.planLabel,
    category: o.category,
    term: o.term,
    amount: o.amount,
    currency: o.currency,
    name: o.name,
    email: o.email,
    phone: o.phone,
    address: o.address,
    method: o.method,
    status: o.status,
    codeId: o.codeId,
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    cancelledAt: o.cancelledAt,
    mailedAt: o.mailedAt,
    mailVia: o.mailVia,
    mailError: o.mailError,
    note: o.note,
  };
}

/** What a buyer is allowed to see about their own order, by unguessable id. */
function ownView(o) {
  return {
    id: o.id,
    number: o.number,
    plan: o.plan,
    planLabel: o.planLabel,
    category: o.category,
    term: o.term,
    amount: o.amount,
    currency: o.currency,
    status: o.status,
    paidAt: o.paidAt,
    mailedAt: o.mailedAt,
    /* Until it is paid there is no code to leak; once it is paid, the code is
     * in the buyer's inbox already, so showing it here saves a support call. */
    code: o.status === 'paid' ? o.code : null,
  };
}

function stats() {
  const paid = orders.filter(o => o.status === 'paid');
  const pending = orders.filter(o => o.status === 'pending');
  const byCategory = { workspace: 0, shop: 0 };
  let total = 0;
  for (const o of paid) {
    total += Number(o.amount) || 0;
    if (byCategory[o.category] !== undefined) byCategory[o.category] += 1;
  }
  return {
    orders: orders.length,
    paid: paid.length,
    pending: pending.length,
    cancelled: orders.filter(o => o.status === 'cancelled').length,
    licences: byCategory,
    takings: total,
    currency: 'INR',
  };
}

module.exports = {
  init, create, markPaid, resend, cancel, remove, get, all, view, ownView, stats, payment,
  publicUrl, licenceEmail,
};
