/* Printers — the walk-up registry.
 *
 * These are the machines people walk up to. Each one has a code that is printed
 * on its sticker, a category that decides the whole guest flow (free workspace
 * or paid shop) and a destination somewhere else in PrintBridge that does the
 * actual printing. The code is the product: whoever holds it can send a
 * document to this printer and nothing else, and the owner can pause it at any
 * moment.
 */

import { api } from '../api.js';
import {
  esc, icons, toast, confirmDialog, emptyState, openOverlay, closeOverlay, copyText, note,
} from '../../app/ui.js';

const PAPERS = [['a4', 'A4'], ['letter', 'Letter'], ['legal', 'Legal'], ['a5', 'A5']];
const ORIENTATIONS = [['portrait', 'Portrait'], ['landscape', 'Landscape']];
const CURRENCIES = [['INR', 'INR (₹)'], ['USD', 'USD ($)'], ['EUR', 'EUR (€)'], ['GBP', 'GBP (£)']];
const SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };
const TWO_UP = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px';

let cache = [];
let targets = null;

export async function render(container, _params, ctx) {
  container.innerHTML = shell();
  bindShell(container, ctx);
  await refresh(container, ctx);
  return { update: () => { /* the registry only changes through this view */ } };
}

function shell() {
  return `
  <section class="view">
    <div class="view-head spread wrap">
      <div>
        <h1>Printers</h1>
        <p>Every machine a guest can walk up to. A printer code is what they type on the print site — workspace printers are free, shops charge per page.</p>
      </div>
      <div class="row">
        <button class="btn sm ghost" id="p-refresh">${icons.refresh}<span>Reload</span></button>
        <button class="btn sm primary" id="p-new">${icons.plus}<span>Register a printer</span></button>
      </div>
    </div>
    <div id="p-body"></div>
  </section>`;
}

function bindShell(container, ctx) {
  container.querySelector('#p-new').addEventListener('click', () => openForm(container, ctx, null));
  container.querySelector('#p-refresh').addEventListener('click', () => refresh(container, ctx));
}

async function refresh(container, ctx) {
  const body = container.querySelector('#p-body');
  body.innerHTML = `<div class="skeleton-block" style="height:180px"></div>`;
  try {
    const res = await api.printers();
    cache = res.printers || [];
  } catch (e) {
    body.innerHTML = `<div class="card">${note(`Could not load printers: ${e.message}`, 'bad')}</div>`;
    return;
  }
  paint(container, ctx);
}

function money(amount, currency) {
  const symbol = SYMBOLS[currency] || `${currency} `;
  const value = Number(amount || 0);
  return symbol + (Number.isInteger(value) ? value : value.toFixed(2));
}

function paint(container, ctx) {
  const body = container.querySelector('#p-body');
  if (!cache.length) {
    body.innerHTML = `<div class="card">${emptyState({
      iconName: 'printer',
      title: 'No walk-up printers yet',
      text: 'Register one to get the code you can stick on the machine.',
      action: '<button class="btn primary" id="p-new-2">' + icons.plus + '<span>Register a printer</span></button>',
    })}</div>`;
    const again = body.querySelector('#p-new-2');
    if (again) again.addEventListener('click', () => openForm(container, ctx, null));
    return;
  }

  const live = cache.filter(p => p.active).length;
  const shops = cache.filter(p => p.category === 'shop').length;

  body.innerHTML = `
    <div class="tile-grid" style="margin-bottom:18px">
      <article class="tile">
        <span class="muted small">Walk-up printers</span>
        <strong>${cache.length}</strong>
        <span class="muted small">registered</span>
      </article>
      <article class="tile">
        <span class="muted small">Taking jobs right now</span>
        <strong>${live}</strong>
        <span class="muted small">${cache.length - live} paused</span>
      </article>
      <article class="tile">
        <span class="muted small">Paid shops</span>
        <strong>${shops}</strong>
        <span class="muted small">${cache.length - shops} free</span>
      </article>
    </div>

    <div class="tile-grid">${cache.map(tile).join('')}</div>

    <div class="card" style="margin-top:18px">${note(
      'Guests only ever see the code, the printer’s name and what it can do. Where it prints and what it costs stay here.',
      'info')}</div>`;

  body.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('click', () => {
      const printer = cache.find(p => p.id === el.dataset.id);
      if (!printer) return;
      const act = el.dataset.act;
      if (act === 'edit') openForm(container, ctx, printer);
      else if (act === 'toggle') toggle(container, ctx, printer);
      else if (act === 'remove') remove(container, ctx, printer);
      else if (act === 'card') printCard(printer);
      else if (act === 'copy') copyText(printer.code, `Code ${printer.code} copied`);
    });
  });
}

function tile(p) {
  const price = p.pricing
    ? `${money(p.pricing.colorPerPage, p.pricing.currency)} colour · ${money(p.pricing.monoPerPage, p.pricing.currency)} B&W`
    : 'free to print';
  const caps = [
    (p.capabilities.papers || []).map(x => x.toUpperCase()).join(' · '),
    p.capabilities.duplex ? 'Duplex' : 'Single-sided',
    p.capabilities.color ? 'Colour' : 'Mono',
  ].filter(Boolean).join(' · ');

  return `
  <article class="tile">
    <div class="spread wrap">
      <span class="chip ${p.category === 'shop' ? 'soft' : 'ok'}">${p.category === 'shop' ? 'Shop' : 'Workspace'}</span>
      <span class="chip ${p.active ? 'ok' : 'bad'}">${p.active ? 'Live' : 'Paused'}</span>
    </div>
    <button class="btn sm mono" data-act="copy" data-id="${esc(p.id)}" title="Copy this code" style="align-self:flex-start;letter-spacing:0.08em">${esc(p.code)}</button>
    <strong style="font-size:1.05rem">${esc(p.name)}</strong>
    <span class="small muted">${esc(caps)}</span>
    ${p.note ? `<span class="small muted">${esc(p.note)}</span>` : ''}
    <span class="small"><b>${esc(price)}</b></span>
    <span class="small muted">prints at <code>${esc(p.target || 'nothing yet')}</code></span>
    <div class="row wrap" style="gap:6px;margin-top:10px">
      <button class="btn sm ghost" data-act="card" data-id="${esc(p.id)}" title="Print a sticker for this machine">${icons.printer}<span>Sticker</span></button>
      <button class="btn sm ghost" data-act="edit" data-id="${esc(p.id)}">Edit</button>
      <button class="btn sm ghost" data-act="toggle" data-id="${esc(p.id)}">${p.active ? 'Pause' : 'Resume'}</button>
      <button class="btn sm ghost danger" data-act="remove" data-id="${esc(p.id)}" aria-label="Delete ${esc(p.name)}">${icons.trash}</button>
    </div>
  </article>`;
}

/* ---------------- actions ---------------- */

async function toggle(container, ctx, printer) {
  try {
    await api.updatePrinter(printer.id, { active: !printer.active });
    toast(printer.active ? 'Printer paused' : 'Printer live', printer.code);
    await refresh(container, ctx);
  } catch (e) {
    toast('Could not change that printer', e.message, 'err');
  }
}

async function remove(container, ctx, printer) {
  const ok = await confirmDialog({
    title: `Delete ${printer.name}?`,
    message: `The code ${printer.code} stops working immediately. Documents already sent are not affected.`,
    confirmLabel: 'Delete printer',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deletePrinter(printer.id);
    toast('Printer deleted', printer.code);
    await refresh(container, ctx);
  } catch (e) {
    toast('Could not delete that printer', e.message, 'err');
  }
}

/* The sticker: a printable card whose QR opens the print site with this code
 * already filled in, plus the code in plain text for anyone who types it. */
function printCard(printer) {
  const url = `${location.origin}/print/?code=${encodeURIComponent(printer.code)}`;
  api.printCard(url)
    .then(() => toast('Sticker sent to the printer', `${printer.code} — stick it on the machine.`))
    .catch((e) => toast('Could not print the sticker', e.message, 'err'));
}

/* ---------------- destinations ---------------- */

async function loadTargets() {
  if (targets) return targets;
  const found = await api.printerLocate({ mdns: false, scan: false }).catch(() => ({ windowsQueues: [], cupsQueues: [], networkPrinters: [] }));
  const list = [];
  for (const q of (found.windowsQueues || [])) {
    if (/print to pdf|onenote|xps document writer|fax/i.test(q.name)) continue;
    list.push({ value: `spooler:${q.name}`, label: `${q.name} — Windows queue${q.kind ? ` (${q.kind})` : ''}` });
  }
  for (const q of (found.cupsQueues || [])) {
    list.push({ value: `cups:${q.name}`, label: `${q.name} — CUPS queue` });
  }
  for (const p of (found.networkPrinters || [])) {
    if (p.kind !== 'ipp' || !p.url) continue;
    list.push({ value: `ipp:${p.url}`, label: `${p.name || p.host} — network printer` });
  }
  list.push({ value: 'outbox', label: 'Outbox — keep the print-ready PDF instead of printing' });
  targets = list;
  return list;
}

/* ---------------- the form ---------------- */

function openForm(container, ctx, printer) {
  const editing = Boolean(printer);
  const overlay = openOverlay(`
    <div class="modal" style="max-width:640px">
      <div class="modal-head">
        <h2>${editing ? 'Edit printer' : 'Register a printer'}</h2>
        <button class="icon-btn" data-close aria-label="Close">${icons.x}</button>
      </div>
      <div class="modal-body">
        <div id="pf-loading" class="row"><span class="skeleton-block" style="height:60px;flex:1"></span></div>

        <form id="pf" class="hidden" autocomplete="off">
          <div style="${TWO_UP}">
            <div class="field">
              <label for="pf-name">Name</label>
              <input class="input" id="pf-name" placeholder="Ground floor copier" required>
            </div>
            <div class="field">
              <label for="pf-category">Category</label>
              <select class="input" id="pf-category">
                <option value="workspace">Workspace — free to print</option>
                <option value="shop">Shop / business — paid per page</option>
              </select>
            </div>
          </div>

          <div class="field">
            <label for="pf-note">Where to find it (guests see this)</label>
            <input class="input" id="pf-note" placeholder="Next to reception, ask at the desk">
          </div>

          <div class="field">
            <label for="pf-target">Destination — the machine that really prints</label>
            <select class="input" id="pf-target"></select>
          </div>
          <div class="field">
            <label for="pf-manual">…or type a destination by hand</label>
            <input class="input mono" id="pf-manual" placeholder="ipp://192.168.1.50:631/ipp/print" spellcheck="false">
          </div>

          <div class="group-label">What this printer can do</div>
          <div class="field">
            <span class="opt-label">Paper sizes</span>
            <div class="row wrap" id="pf-papers" style="gap:16px">
              ${PAPERS.map(([value, label]) => `
                <label class="check-row" style="padding:0"><input type="checkbox" value="${value}"${value === 'a4' ? ' checked' : ''}><span>${label}</span></label>`).join('')}
            </div>
          </div>
          <div class="field">
            <span class="opt-label">Orientation</span>
            <div class="row wrap" id="pf-orientations" style="gap:16px">
              ${ORIENTATIONS.map(([value, label]) => `
                <label class="check-row" style="padding:0"><input type="checkbox" value="${value}" checked><span>${label}</span></label>`).join('')}
            </div>
          </div>
          <div class="row wrap" style="gap:22px;margin:4px 0 2px">
            <label class="check-row" style="padding:0"><input type="checkbox" id="pf-duplex"><span>Prints on both sides</span></label>
            <label class="check-row" style="padding:0"><input type="checkbox" id="pf-color"><span>Prints in colour</span></label>
          </div>

          <div id="pf-pricing" class="hidden">
            <div class="group-label">Prices the guest pays</div>
            <div style="${TWO_UP}">
              <div class="field">
                <label for="pf-currency">Currency</label>
                <select class="input" id="pf-currency">
                  ${CURRENCIES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
                </select>
              </div>
              <div class="field" id="pf-color-field">
                <label for="pf-color-rate">Colour, per page</label>
                <input class="input" id="pf-color-rate" inputmode="decimal" placeholder="4">
              </div>
              <div class="field">
                <label for="pf-mono-rate">Black &amp; white, per page</label>
                <input class="input" id="pf-mono-rate" inputmode="decimal" placeholder="1.5">
              </div>
            </div>
            <div class="small muted">A shop job is sent only after the guest has paid. Every page is charged, including the code page in front.</div>
          </div>

          <div id="pf-code"></div>
          <div id="pf-error"></div>
        </form>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn primary" id="pf-save" form="pf" disabled>${editing ? 'Save changes' : 'Register printer'}</button>
      </div>
    </div>
  `, { onMount: (root) => wire(root) });

  function wire(root) {
    const form = root.querySelector('#pf');
    const category = root.querySelector('#pf-category');
    const select = root.querySelector('#pf-target');
    const save = root.querySelector('#pf-save');
    const colorCheck = root.querySelector('#pf-color');

    root.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeOverlay));

    const paintPricing = () => {
      root.querySelector('#pf-pricing').classList.toggle('hidden', category.value !== 'shop');
      root.querySelector('#pf-color-field').classList.toggle('hidden', !colorCheck.checked);
    };

    const paintCode = () => {
      const host = root.querySelector('#pf-code');
      if (!editing) { host.innerHTML = ''; return; }
      host.innerHTML = `
        <div class="group-label">Printer code</div>
        <div class="card" style="margin:0 0 12px">
          <div class="spread wrap">
            <div>
              <div class="mono" style="font-size:1.15rem;letter-spacing:0.08em">${esc(printer.code)}</div>
              <div class="small muted" style="margin-top:4px">This is what guests type, and what the sticker shows.</div>
            </div>
            <button type="button" class="btn sm ghost" data-copy>${icons.copy}<span>Copy</span></button>
          </div>
        </div>`;
      host.querySelector('[data-copy]').addEventListener('click', () => copyText(printer.code, 'Printer code copied'));
    };

    if (editing) {
      root.querySelector('#pf-name').value = printer.name || '';
      root.querySelector('#pf-note').value = printer.note || '';
      category.value = printer.category || 'workspace';
      root.querySelector('#pf-duplex').checked = Boolean(printer.capabilities.duplex);
      colorCheck.checked = Boolean(printer.capabilities.color);
      for (const box of root.querySelectorAll('#pf-papers input')) {
        box.checked = (printer.capabilities.papers || []).includes(box.value);
      }
      for (const box of root.querySelectorAll('#pf-orientations input')) {
        box.checked = (printer.capabilities.orientations || []).includes(box.value);
      }
      if (printer.pricing) {
        root.querySelector('#pf-currency').value = printer.pricing.currency;
        root.querySelector('#pf-color-rate').value = printer.pricing.colorPerPage;
        root.querySelector('#pf-mono-rate').value = printer.pricing.monoPerPage;
      }
    }
    paintCode();
    paintPricing();
    category.addEventListener('change', paintPricing);
    colorCheck.addEventListener('change', paintPricing);

    (async () => {
      const list = await loadTargets();
      select.innerHTML = list.map(t => `<option value="${esc(t.value)}">${esc(t.label)}</option>`).join('');
      if (editing && printer.target) {
        if (!list.some(t => t.value === printer.target)) {
          select.insertAdjacentHTML('afterbegin', `<option value="${esc(printer.target)}">${esc(printer.target)}</option>`);
        }
        select.value = printer.target;
      }
      root.querySelector('#pf-loading').classList.add('hidden');
      form.classList.remove('hidden');
      save.disabled = false;
    })();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const error = root.querySelector('#pf-error');
      error.innerHTML = '';
      save.disabled = true;

      const manual = root.querySelector('#pf-manual').value.trim();
      const body = {
        name: root.querySelector('#pf-name').value.trim(),
        note: root.querySelector('#pf-note').value.trim(),
        category: category.value,
        target: manual || select.value || '',
        capabilities: {
          papers: [...root.querySelectorAll('#pf-papers input:checked')].map(b => b.value),
          orientations: [...root.querySelectorAll('#pf-orientations input:checked')].map(b => b.value),
          duplex: root.querySelector('#pf-duplex').checked,
          color: colorCheck.checked,
        },
      };
      if (category.value === 'shop') {
        body.pricing = {
          currency: root.querySelector('#pf-currency').value,
          colorPerPage: Number(root.querySelector('#pf-color-rate').value || 0),
          monoPerPage: Number(root.querySelector('#pf-mono-rate').value || 0),
        };
      }

      try {
        if (editing) await api.updatePrinter(printer.id, body);
        else await api.createPrinter(body);
        closeOverlay();
        toast(editing ? 'Printer updated' : 'Printer registered', `${body.name} — the sticker card is one click away.`);
        await refresh(container, ctx);
      } catch (e) {
        error.innerHTML = note(e.message, 'bad');
        save.disabled = false;
      }
    });
  }

  return overlay;
}
