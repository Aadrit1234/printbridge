/* Revenue & reports — what the shop took, against what it spent.
 *
 * Revenue is not typed in and not estimated: it is the amount the *machine*
 * charged, recomputed at every checkout from the shop's own prices. This panel
 * only counts jobs that printed at printers this licence owns, so a demo
 * printer, a colleague's machine or a neighbouring shop contributes nothing.
 *
 * Expenses come from the local copy of the shop's document (see renderer/shop.js),
 * which means the ledger still balances when the machine is away: the last
 * report fetched is kept, marked as old, and the expenses on screen are current.
 * Net is the subtraction, and it is the number this panel exists for.
 */

import { shopApi } from '../api.js';
import * as shop from '../shop.js';
import { esc, toast } from '../../public/app/ui.js';

let host = null;
let range = { from: '', to: '' };
let report = null;
let stale = false;
let loading = false;

function firstOfMonth() {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

export async function render(viewHost) {
  host = viewHost;
  if (!range.from && !range.to) range = { from: firstOfMonth(), to: '' };
  await shop.load();
  await load();
  return {
    update() { paint(); },
    destroy() { host = null; },
  };
}

async function load() {
  loading = true;
  paint();
  try {
    report = await shopApi.reports(range);
    stale = false;
    await shop.rememberReport(report);
  } catch (error) {
    const saved = shop.get();
    if (saved && saved.lastReport) {
      report = saved.lastReport;
      stale = true;
    } else {
      report = null;
      toast('Could not read the machine', error.message, 'warn');
    }
  } finally {
    loading = false;
    paint();
  }
}

function money(amount, currency) {
  return `${currency} ${Number(amount || 0).toFixed(2)}`;
}

function quick(label, from, to = '') {
  const active = range.from === from && range.to === to;
  return `<button class="btn sm ${active ? 'primary' : 'ghost'}" data-range="${esc(from)}|${esc(to)}" type="button">${esc(label)}</button>`;
}

function paint() {
  if (!host) return;
  const currency = (report && report.currency) || shop.settings().currency || 'INR';
  const totals = (report && report.totals) || { jobs: 0, pages: 0, revenue: 0, expenses: 0, net: 0, unpaidJobs: 0, tax: 0 };
  const state = shop.syncState();

  const days = (report && report.byDay) || [];
  const byPrinter = (report && report.byPrinter) || [];
  const byCategory = (report && report.byCategory) || [];
  const byMode = (report && report.byMode) || [];

  host.innerHTML = `
  <header class="section-head">
    <div>
      <h1>Revenue &amp; reports</h1>
      <p class="lead">What printed at this shop's printers, what it charged, and what the shop spent —
      the two sides of the ledger in one place.</p>
    </div>
    <div class="row">
      <a class="btn ghost" id="rep-csv" ${report ? '' : 'disabled'} href="${esc(shopApi.csvUrl(range))}" download>Download CSV</a>
    </div>
  </header>

  <div class="sync-strip">
    <span class="chip ${stale ? 'warn' : 'ok'}">${stale ? 'the machine is not reachable — this is the last report it gave' : 'read from the machine'}</span>
    <span class="chip ${state.kind === 'synced' ? 'ok' : 'warn'}">expenses: ${esc(state.text)}</span>
  </div>

  <section class="card">
    <div class="card-head">
      <h2>Period</h2>
      <div class="row wrap" style="gap:6px">
        ${quick('This month', firstOfMonth())}
        ${quick('Last 30 days', isoDaysAgo(30))}
        ${quick('This year', `${new Date().getFullYear()}-01-01`)}
        ${quick('Everything', '', '')}
      </div>
    </div>
    <form class="row wrap" id="rep-form" autocomplete="off">
      <input class="input" id="rep-from" type="date" value="${esc(range.from)}" style="width:160px">
      <input class="input" id="rep-to" type="date" value="${esc(range.to)}" style="width:160px">
      <button class="btn" type="submit" ${loading ? 'disabled' : ''}>${loading ? 'Reading…' : 'Apply'}</button>
    </form>
  </section>

  <div class="stat-row">
    <div class="stat"><span class="muted small">Revenue</span><b>${esc(money(totals.revenue, currency))}</b></div>
    <div class="stat"><span class="muted small">Expenses</span><b>${esc(money(totals.expenses, currency))}</b></div>
    <div class="stat ${totals.net < 0 ? 'is-negative' : 'is-positive'}"><span class="muted small">Net</span><b>${esc(money(totals.net, currency))}</b></div>
  </div>

  <section class="card">
    <div class="card-head"><h2>The period in numbers</h2></div>
    <div class="line"><span>Jobs printed</span><b>${esc(String(totals.jobs))}</b></div>
    <div class="line"><span>Pages</span><b>${esc(String(totals.pages))}</b></div>
    <div class="line"><span>Average per job</span><b>${esc(money(totals.jobs ? totals.revenue / totals.jobs : 0, currency))}</b></div>
    ${totals.unpaidJobs ? `<div class="line"><span>Printed without payment</span><b>${esc(String(totals.unpaidJobs))}</b></div>` : ''}
    ${totals.tax ? `<div class="line"><span>Tax set aside (${esc(String(shop.settings().taxPercent))}%)</span><b>${esc(money(totals.tax, currency))}</b></div>` : ''}
  </section>

  ${byPrinter.length ? `
  <section class="card">
    <div class="card-head"><h2>By printer</h2></div>
    ${byPrinter.map(row => `
      <div class="line">
        <span>${esc(row.name)} <span class="muted small">${esc(String(row.jobs))} job(s) · ${esc(String(row.pages))} page(s)</span></span>
        <b>${esc(money(row.revenue, currency))}</b>
      </div>`).join('')}
  </section>` : ''}

  ${byMode.length ? `
  <section class="card">
    <div class="card-head"><h2>Colour and mono</h2></div>
    ${byMode.map(row => `
      <div class="line">
        <span>${esc(row.mode)} <span class="muted small">${esc(String(row.jobs))} job(s) · ${esc(String(row.pages))} page(s)</span></span>
        <b>${esc(money(row.revenue, currency))}</b>
      </div>`).join('')}
  </section>` : ''}

  ${byCategory.length ? `
  <section class="card">
    <div class="card-head"><h2>What the money went on</h2></div>
    ${byCategory.map(row => `
      <div class="line">
        <span>${esc(row.category)} <span class="muted small">${esc(String(row.count))} entr(ies)</span></span>
        <b>${esc(money(row.amount, currency))}</b>
      </div>`).join('')}
  </section>` : ''}

  ${days.length ? `
  <section class="card">
    <div class="card-head"><h2>Day by day</h2><span class="chip">${days.length} day(s)</span></div>
    <table class="rep-table">
      <thead><tr><th>Day</th><th>Jobs</th><th>Pages</th><th>Revenue</th><th>Expenses</th><th>Net</th></tr></thead>
      <tbody>
        ${days.slice(0, 60).map(day => `
          <tr>
            <td>${esc(day.date)}</td>
            <td>${esc(String(day.jobs))}</td>
            <td>${esc(String(day.pages))}</td>
            <td>${esc(money(day.revenue, currency))}</td>
            <td>${esc(money(day.expenses, currency))}</td>
            <td class="${day.net < 0 ? 'is-negative' : ''}">${esc(money(day.net, currency))}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  </section>` : ''}

  ${!days.length && !loading ? `
  <section class="card">
    <div class="empty">Nothing printed in this period. Widen it, or check that the machine is reachable from this app.</div>
  </section>` : ''}`;

  host.querySelector('#rep-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    range = {
      from: String(host.querySelector('#rep-from').value || ''),
      to: String(host.querySelector('#rep-to').value || ''),
    };
    load();
  });

  host.querySelectorAll('[data-range]').forEach((button) => {
    button.addEventListener('click', () => {
      const [from, to] = String(button.dataset.range).split('|');
      range = { from, to };
      load();
    });
  });
}
