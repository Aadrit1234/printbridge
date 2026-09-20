/* The customer app's window: printers near you, and one button to print.
 *
 * This is the whole interface. It exists because the walk-up flow — scan a
 * sticker, type a code, upload — is a good flow and a bad *app*: a person who
 * prints every day wants a shortcut, not a QR code. Everything after this
 * window is the machine's own print page, untouched. */

import { esc, toast } from '/app/ui.js';
import { applyTheme, toggleTheme } from '/app/theme.js';

const API = window.printbridgeClient;
const $ = (id) => document.getElementById(id);

let current = null;
let known = [];
let found = [];
let scanning = false;

applyTheme(localStorage.getItem('pb.theme') || 'system');
$('theme').addEventListener('click', () => {
  toggleTheme();
  localStorage.setItem('pb.theme', document.documentElement.getAttribute('data-theme') || 'system');
});

function chip(text, cls = '') {
  return `<span class="chip ${cls}">${esc(text)}</span>`;
}

function machineRow(machine, { actions = '' } = {}) {
  const isCurrent = current && current.id === machine.id;
  const away = machine.reachable === false;
  return `
  <div class="client-item${isCurrent ? ' is-current' : ''}">
    <div class="client-item-main">
      <div class="client-item-name">
        ${isCurrent ? '<span class="client-dot" aria-label="the machine in use"></span>' : ''}
        ${esc(machine.name || machine.id)}
      </div>
      <div class="client-item-sub">
        <span class="mono">${esc(machine.id)}</span>
        ${machine.tier ? chip(machine.tier) : ''}
        ${machine.version ? chip(`v${machine.version}`) : ''}
        ${machine.local ? chip('this computer') : ''}
        ${away ? chip('not answering', 'warn') : ''}
      </div>
    </div>
    <div class="client-item-actions">${actions}</div>
  </div>`;
}

function render() {
  /* ---- found on the network ---- */
  const foundHost = $('found');
  const live = found.filter(m => m.reachable);
  if (!found.length) {
    foundHost.innerHTML = `<div class="empty">No printer machine announced itself. Some networks block discovery — you can enter an address below, or use the machine's print page from a browser.</div>`;
  } else if (!live.length) {
    foundHost.innerHTML = found.map(m => machineRow(m, { actions: `<span class="muted small">not answering</span>` })).join('');
  } else {
    foundHost.innerHTML = live.map(m => machineRow(m, {
      actions: `<button class="btn primary sm" data-print="${esc(m.id)}" type="button">Print here</button>`,
    })).join('');
  }

  /* ---- remembered ---- */
  const knownHost = $('known');
  if (!known.length) {
    knownHost.innerHTML = `<div class="empty">Nothing remembered yet. Machines you use are kept here, so tomorrow is one click.</div>`;
  } else {
    knownHost.innerHTML = known.map(m => machineRow(m, {
      actions: `
        <button class="btn ${current && current.id === m.id ? 'primary ' : ''}sm" data-print="${esc(m.id)}" type="button">Print</button>
        <button class="btn sm ghost" data-forget="${esc(m.id)}" type="button">Forget</button>`,
    })).join('');
  }

  $('known-state').textContent = known.length ? `${known.length} remembered` : 'none yet';

  const foot = $('foot-state');
  if (scanning) foot.textContent = 'looking for printers…';
  else if (current) foot.textContent = `ready — ${current.name}`;
  else foot.textContent = 'choose a printer';

  $('client-sub').textContent = current ? current.name : 'printers near you';
  $('print-walkup').disabled = !current;
}

function byId(id) {
  return found.find(m => m.id === id) || known.find(m => m.id === id) || null;
}

async function scan({ quiet = false } = {}) {
  if (scanning) return;
  scanning = true;
  $('scan-state').textContent = 'looking…';
  render();
  try {
    const result = await API.machines.discover();
    found = result.found || [];
    known = result.known || [];
    current = result.current || null;
    $('scan-state').textContent = found.length ? `${found.filter(m => m.reachable).length} answering` : 'none found';
    if (!quiet) {
      const live = found.filter(m => m.reachable).length;
      toast(live ? `Found ${live} printer machine${live === 1 ? '' : 's'}` : 'No printer machines answered', live ? '' : 'Enter an address below, or use the print page in a browser.', live ? 'ok' : 'warn');
    }
  } catch (error) {
    $('scan-state').textContent = 'scan failed';
    toast('Could not look for printers', error.message, 'warn');
  } finally {
    scanning = false;
    render();
  }
}

async function refresh() {
  const info = await API.getInfo();
  current = info.current || null;
  known = info.known || [];
  render();
}

document.addEventListener('click', async (event) => {
  const printId = event.target.closest('[data-print]');
  if (printId) {
    const machine = byId(printId.getAttribute('data-print'));
    if (!machine) return;
    const used = await API.machines.use(machine);
    if (used && used.ok) current = used.machine;
    const opened = await API.print(machine);
    if (!opened || !opened.ok) toast('Could not open the print page', 'The machine may have gone away.', 'warn');
    else await refresh();
    return;
  }

  const forgetId = event.target.closest('[data-forget]');
  if (forgetId) {
    await API.machines.forget(forgetId.getAttribute('data-forget'));
    await refresh();
    return;
  }
});

$('by-hand').addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = $('address').value.trim();
  const errorBox = $('by-hand-error');
  errorBox.classList.add('hidden');
  $('check').disabled = true;
  try {
    const result = await API.machines.check({ address: value });
    if (!result.ok) {
      errorBox.textContent = `Nothing answered there — ${result.reason || 'check the address'}.`;
      errorBox.classList.remove('hidden');
      return;
    }
    $('address').value = '';
    toast(`${result.app} ${result.version}`.trim(), `Remembered ${result.machine.name}`, 'ok');
    await refresh();
    await scan({ quiet: true });
  } finally {
    $('check').disabled = false;
  }
});

$('rescan').addEventListener('click', () => scan());
$('print-walkup').addEventListener('click', async () => {
  if (!current) return;
  await API.print(current);
});
$('open-web').addEventListener('click', (event) => {
  event.preventDefault();
  API.openExternal(current ? `http://${current.id}/print/` : 'https://print-pi-three.vercel.app/');
});

API.onRescan(() => scan());
API.onRefreshed(() => refresh());

(async () => {
  await refresh();
  await scan({ quiet: true });
})();
