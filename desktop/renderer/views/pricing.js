/* Pricing — what this shop charges.
 *
 * Two different things live here, and they are different on purpose:
 *
 *   what a customer pays per page   the printer's own prices. The queue
 *                                   recomputes every checkout from these, so
 *                                   they are edited live, on the machine, and
 *                                   never cached: a stale copy of a price is a
 *                                   customer being charged the wrong amount.
 *   what else this shop sells       lamination, binding, scanning — the shop's
 *                                   own list. It belongs to the licence, lives
 *                                   in the local copy of the shop document,
 *                                   works offline and syncs when it can.
 *
 * The split is the point: prices that take money are the machine's truth, and
 * prices that do not are the shop's own book.
 */

import { api } from '../api.js';
import * as shop from '../shop.js';
import { esc, toast } from '../../public/app/ui.js';

let host = null;
let printers = [];
let printingError = '';
let subscribed = false;

export async function render(viewHost) {
  host = viewHost;
  if (!subscribed) {
    subscribed = true;
    shop.subscribe(() => paint());
  }
  await Promise.all([loadPrinters(), shop.load()]);
  paint();
  return {
    update() { paint(); },
    destroy() { host = null; },
  };
}

async function loadPrinters() {
  try {
    const result = await api.printers();
    printers = result.printers || [];
    printingError = '';
  } catch (error) {
    printers = [];
    printingError = error.message;
  }
}

function syncStrip() {
  const state = shop.syncState();
  const tone = state.kind === 'synced' ? 'ok' : state.kind === 'pending' ? 'warn' : '';
  return `
  <div class="sync-strip">
    <span class="chip ${tone}">${esc(state.text)}</span>
    <button class="btn sm ghost" id="price-sync" type="button">Sync now</button>
  </div>`;
}

function printerRow(printer) {
  const pricing = printer.pricing || {};
  const rates = pricing.rates || pricing; // admin view or owner view
  const currency = rates.currency || 'INR';
  const color = rates.colorPerPage == null ? '' : rates.colorPerPage;
  const mono = rates.monoPerPage == null ? '' : rates.monoPerPage;
  const isShop = printer.category === 'shop';
  return `
  <form class="rate-row" data-printer="${esc(printer.id)}">
    <div class="rate-name">
      <b>${esc(printer.name || printer.id)}</b>
      <span class="muted small">${esc(printer.code || '')} · ${esc(printer.category || '')}</span>
    </div>
    <label class="rate-field">
      <span>Colour / page</span>
      <input class="input" name="colorPerPage" type="number" step="0.01" min="0" value="${esc(String(color))}" ${isShop ? '' : 'disabled'}>
    </label>
    <label class="rate-field">
      <span>Mono / page</span>
      <input class="input" name="monoPerPage" type="number" step="0.01" min="0" value="${esc(String(mono))}" ${isShop ? '' : 'disabled'}>
    </label>
    <label class="rate-field">
      <span>Currency</span>
      <input class="input" name="currency" value="${esc(currency)}" maxlength="3" style="width:74px" ${isShop ? '' : 'disabled'}>
    </label>
    <div class="rate-actions">
      ${isShop
        ? '<button class="btn sm primary" type="submit">Save</button>'
        : '<span class="muted small">free to print — no price applies</span>'}
    </div>
  </form>`;
}

function serviceRow(service) {
  return `
  <div class="svc-row">
    <div>
      <b>${esc(service.label || '')}</b>
      <div class="muted small">${esc(service.kind || 'flat')}${service.note ? ` · ${esc(service.note)}` : ''}</div>
    </div>
    <div class="rate-actions">
      <span class="money">${esc(service.currency || 'INR')} ${esc(Number(service.amount || 0).toFixed(2))}</span>
      <button class="btn sm ghost" data-del-service="${esc(service.id)}" type="button">Remove</button>
    </div>
  </div>`;
}

function paint() {
  if (!host) return;
  const account = shop.signedInAccount();
  const services = shop.liveServices();
  const settings = shop.settings();

  host.innerHTML = `
  <header class="section-head">
    <div>
      <h1>Pricing</h1>
      <p class="lead">What this shop charges. Per-page prices are the machine's — every checkout is
      recomputed from them — and anything else you sell is this shop's own list.</p>
    </div>
  </header>

  ${syncStrip()}

  <section class="card">
    <div class="card-head"><h2>Per page, at the counter</h2><span class="chip">${printers.filter(p => p.category === 'shop').length} shop printer(s)</span></div>
    ${printingError ? `<div class="job-error">${esc(printingError)}</div>` : ''}
    ${printers.length
      ? printers.map(printerRow).join('')
      : '<div class="empty">No printers are registered on this machine yet. Register one in the Printers panel and its prices appear here.</div>'}
    <p class="muted small" style="margin-top:10px">A workspace printer is free to print at, so it has no prices — that is not an omission.</p>
  </section>

  <section class="card">
    <div class="card-head"><h2>Anything else you sell</h2><span class="chip">${services.length}</span></div>
    ${account
      ? `<p class="muted small">Lamination, binding, scanning, a colour copy done by hand — things the machine does not print,
         but the shop does. They are kept with this licence and sync to the machine, so every till shows the same list.</p>
        ${services.length ? services.map(serviceRow).join('') : '<div class="empty">Nothing yet. Add what you charge for by hand.</div>'}
        <form class="row wrap svc-form" id="svc-form" autocomplete="off">
          <input class="input" name="label" placeholder="Lamination (per page)" required>
          <select class="input" name="kind">
            <option value="perPage">per page</option>
            <option value="perJob">per job</option>
            <option value="flat">flat</option>
          </select>
          <input class="input" name="amount" type="number" step="0.01" min="0" placeholder="10.00" required style="width:120px">
          <button class="btn" type="submit">Add</button>
        </form>`
      : `<div class="empty">Sign in with the owner account (Account panel) to keep a price list for this shop.
         The per-page prices above still work — they belong to the machine.</div>`}
  </section>`;

  host.querySelector('#price-sync')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    const result = await shop.sync({ force: true });
    event.target.disabled = false;
    toast(result.ok ? 'In step with the machine' : 'Could not reach the machine', result.ok ? '' : (result.error || ''), result.ok ? 'ok' : 'warn');
  });

  host.querySelectorAll('.rate-row').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = form.dataset.printer;
      const data = new FormData(form);
      const body = {
        pricing: {
          currency: String(data.get('currency') || 'INR').toUpperCase().slice(0, 3),
          colorPerPage: Number(data.get('colorPerPage')),
          monoPerPage: Number(data.get('monoPerPage')),
        },
      };
      const button = form.querySelector('button[type="submit"]');
      if (button) { button.disabled = true; button.textContent = 'Saving…'; }
      try {
        await api.updatePrinter(id, body);
        toast('Prices saved on the machine', `Colour ${body.pricing.currency} ${body.pricing.colorPerPage} · mono ${body.pricing.currency} ${body.pricing.monoPerPage}`, 'ok');
        await loadPrinters();
      } catch (error) {
        toast('Could not save the prices', error.message, 'err');
      } finally {
        paint();
      }
    });
  });

  host.querySelector('#svc-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    const result = await shop.saveService({
      label: String(data.get('label') || '').trim(),
      kind: String(data.get('kind') || 'flat'),
      amount: Number(data.get('amount')),
      currency: settings.currency || 'INR',
    });
    if (!result.ok && !result.skipped) toast('Saved here', result.error || 'the machine has not taken it yet', 'warn');
    event.target.reset();
  });

  host.querySelectorAll('[data-del-service]').forEach((button) => {
    button.addEventListener('click', () => shop.deleteService(button.dataset.delService));
  });
}
