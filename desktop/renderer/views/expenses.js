/* Expenses — what the shop spends.
 *
 * This is the panel that works when nothing else does. It is written to this
 * computer first and synced to the machine afterwards, so paper bought on a
 * morning the network is down is still recorded on the morning it was bought,
 * by the person who bought it. The merge is newest-wins per row and a delete
 * travels as a tombstone, so a second laptop cannot resurrect a mistake.
 *
 * Categories are the machine's vocabulary (a fixed list) rather than free text:
 * "paper" typed four ways is four categories, and a report grouped by them is
 * worth nothing.
 */

import * as shop from '../shop.js';
import { esc, toast } from '../../public/app/ui.js';

let host = null;
let subscribed = false;
let filter = { month: '' };

export async function render(viewHost) {
  host = viewHost;
  if (!subscribed) {
    subscribed = true;
    shop.subscribe(() => paint());
  }
  await shop.load();
  paint();
  return {
    update() { paint(); },
    destroy() { host = null; },
  };
}

const CATEGORIES = ['paper', 'ink', 'toner', 'maintenance', 'rent', 'electricity', 'wages', 'transport', 'other'];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function thisMonth() {
  return today().slice(0, 7);
}

function money(amount, currency = 'INR') {
  return `${currency} ${Number(amount || 0).toFixed(2)}`;
}

function visible(expenses) {
  if (!filter.month) return expenses;
  return expenses.filter(record => String(record.date || '').startsWith(filter.month));
}

function totals(expenses) {
  const sum = (list) => Math.round(list.reduce((total, record) => total + Number(record.amount || 0), 0) * 100) / 100;
  const month = expenses.filter(r => String(r.date || '').startsWith(thisMonth()));
  const last30 = expenses.filter(r => r.date && r.date >= new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  return { all: sum(expenses), month: sum(month), last30: sum(last30) };
}

function paint() {
  if (!host) return;
  const account = shop.signedInAccount();
  const currency = shop.settings().currency || 'INR';
  const all = shop.liveExpenses();
  const rows = visible(all);
  const sums = totals(all);
  const state = shop.syncState();
  const tone = state.kind === 'synced' ? 'ok' : state.kind === 'pending' ? 'warn' : '';

  /* What the money went on, this month — the number a shopkeeper actually
   * looks at, so it is computed from the visible rows rather than the whole
   * history. */
  const byCategory = new Map();
  for (const record of rows) {
    const key = record.category || 'other';
    byCategory.set(key, (byCategory.get(key) || 0) + Number(record.amount || 0));
  }

  host.innerHTML = `
  <header class="section-head">
    <div>
      <h1>Expenses</h1>
      <p class="lead">Paper, ink, toner, rent, wages — recorded here first, synced to the machine when it is reachable.
      Nothing you enter here waits for the network.</p>
    </div>
  </header>

  <div class="sync-strip">
    <span class="chip ${tone}">${esc(state.text)}</span>
    <button class="btn sm ghost" id="exp-sync" type="button">Sync now</button>
  </div>

  <div class="stat-row">
    <div class="stat"><span class="muted small">This month</span><b>${esc(money(sums.month, currency))}</b></div>
    <div class="stat"><span class="muted small">Last 30 days</span><b>${esc(money(sums.last30, currency))}</b></div>
    <div class="stat"><span class="muted small">Everything recorded</span><b>${esc(money(sums.all, currency))}</b></div>
  </div>

  ${account ? `
  <section class="card">
    <div class="card-head"><h2>Record something bought</h2></div>
    <form class="row wrap" id="exp-form" autocomplete="off">
      <input class="input" name="date" type="date" value="${today()}" required style="width:160px">
      <select class="input" name="category" required style="width:150px">
        ${CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
      </select>
      <input class="input" name="vendor" placeholder="Where from" style="min-width:150px">
      <input class="input" name="amount" type="number" step="0.01" min="0" placeholder="Amount" required style="width:120px">
      <input class="input" name="note" placeholder="Note (optional)" style="min-width:150px">
      <button class="btn primary" type="submit">Record it</button>
    </form>
  </section>` : `<section class="card"><div class="empty">Sign in with the owner account — the Account panel — to keep this shop's expenses. They belong to the licence, not to the machine.</div></section>`}

  <section class="card">
    <div class="card-head">
      <h2>What went out</h2>
      <div class="row" style="gap:8px">
        <input class="input" id="exp-filter" type="month" value="${esc(filter.month || '')}" style="width:150px">
        ${filter.month ? '<button class="btn sm ghost" id="exp-clear" type="button">All time</button>' : ''}
      </div>
    </div>
    ${rows.length ? rows.map(record => `
      <div class="exp-row">
        <div>
          <b>${esc(record.vendor || record.category || 'expense')}</b>
          <div class="muted small">${esc(record.date || '')} · ${esc(record.category || '')}${record.note ? ` · ${esc(record.note)}` : ''}</div>
        </div>
        <div class="rate-actions">
          <span class="money">${esc(money(record.amount, record.currency || currency))}</span>
          ${account ? `<button class="btn sm ghost" data-del="${esc(record.id)}" type="button">Remove</button>` : ''}
        </div>
      </div>`).join('')
      : '<div class="empty">Nothing recorded yet.</div>'}
  </section>

  ${byCategory.size ? `
  <section class="card">
    <div class="card-head"><h2>By category${filter.month ? ` · ${esc(filter.month)}` : ' · everything'}</h2></div>
    ${[...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([category, amount]) => `
      <div class="cat-row">
        <span>${esc(category)}</span>
        <b>${esc(money(amount, currency))}</b>
      </div>`).join('')}
  </section>` : ''}`;

  host.querySelector('#exp-sync')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    const result = await shop.sync({ force: true });
    event.target.disabled = false;
    toast(result.ok ? 'In step with the machine' : 'Saved here — the machine has not taken it yet',
      result.ok ? '' : (result.error || ''), result.ok ? 'ok' : 'warn');
  });

  host.querySelector('#exp-filter')?.addEventListener('change', (event) => {
    filter.month = String(event.target.value || '');
    paint();
  });

  host.querySelector('#exp-clear')?.addEventListener('click', () => {
    filter.month = '';
    paint();
  });

  host.querySelector('#exp-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    const result = await shop.saveExpense({
      date: String(data.get('date') || today()),
      category: String(data.get('category') || 'other'),
      vendor: String(data.get('vendor') || '').trim(),
      note: String(data.get('note') || '').trim(),
      amount: Number(data.get('amount')),
      currency,
    });
    event.target.reset();
    const form = event.target;
    form.querySelector('[name="date"]').value = today();
    if (!result.ok && !result.skipped) toast('Recorded on this computer', result.error || 'the machine has not taken it yet', 'warn');
    else toast('Recorded', 'In step with the machine', 'ok');
  });

  host.querySelectorAll('[data-del]').forEach((button) => {
    button.addEventListener('click', async () => {
      await shop.deleteExpense(button.dataset.del);
      toast('Removed', 'It will not come back on the next sync', 'ok');
    });
  });
}
