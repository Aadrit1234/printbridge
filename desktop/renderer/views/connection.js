/* Machines — the printer this console is looking at.
 *
 * The machine's own app never needs this panel: it *is* the machine. The shop's
 * app opens here, because a shop's printer is in another room, and the first
 * question of the day is which machine the numbers are coming from.
 *
 * A machine is found, not configured: the print service announces itself on the
 * network (_printbridge._tcp), this panel lists what answers, and choosing one
 * points the whole console at it — queue, codes, printers, and the fleet the
 * revenue report counts. An address can be typed instead for a machine that has
 * to be reached across a tailnet or a VPN, where multicast never arrives.
 */

import { desktop } from '../api.js';
import { esc, icons, toast } from '../../public/app/ui.js';

let host = null;
let data = { current: null, known: [], found: [] };
let scanning = false;

export async function render(viewHost) {
  host = viewHost;
  await refresh();
  scan();
  return {
    update() { paint(); },
    destroy() { host = null; },
  };
}

async function refresh() {
  data = await desktop.machines.list().catch(() => ({ current: null, known: [], found: [] }));
  if (!data.found) data.found = [];
  paint();
}

async function scan() {
  if (scanning) return;
  scanning = true;
  paint();
  try {
    const result = await desktop.machines.discover();
    data = { current: result.current, known: result.known || [], found: result.found || [] };
  } catch (error) {
    toast('Could not look for machines', error.message, 'err');
  } finally {
    scanning = false;
    paint();
  }
}

function row(machine, { current = false, found = false, actions = '' } = {}) {
  const chips = [
    machine.tier ? `<span class="chip">${esc(machine.tier)}</span>` : '',
    machine.version ? `<span class="chip">v${esc(machine.version)}</span>` : '',
    machine.local ? '<span class="chip">this computer</span>' : '',
    found && machine.reachable === false ? '<span class="chip warn">not answering</span>' : '',
    machine.lastSeen ? `<span class="chip">seen ${esc(new Date(machine.lastSeen).toLocaleString())}</span>` : '',
  ].filter(Boolean).join('');
  return `
  <div class="conn-row${current ? ' is-current' : ''}">
    <div>
      <div class="conn-name">${current ? icons.checkmark || '' : ''}${esc(machine.name || machine.id)}</div>
      <div class="conn-sub"><code>${esc(machine.host)}:${esc(String(machine.port))}</code>${chips}</div>
    </div>
    <div class="conn-actions">${actions}</div>
  </div>`;
}

function paint() {
  if (!host) return;
  const current = data.current;
  const known = data.known || [];
  const found = data.found || [];

  host.innerHTML = `
  <header class="section-head">
    <div>
      <h1>Machines</h1>
      <p class="lead">The printer machine this app manages. Everything in the console — the queue, the codes,
      the printers, the revenue — is read from the machine chosen here.</p>
    </div>
    <div class="row">
      <button class="btn" id="conn-scan" type="button" ${scanning ? 'disabled' : ''}>${scanning ? 'Looking…' : 'Look for machines'}</button>
    </div>
  </header>

  <section class="card">
    <div class="card-head"><h2>In use now</h2>${current ? '<span class="chip ok">connected</span>' : '<span class="chip warn">nothing chosen</span>'}</div>
    ${current
      ? row(current, { current: true, actions: `
          <button class="btn sm ghost" data-forget="${esc(current.id)}" type="button">Forget</button>` })
      : `<div class="empty">No machine chosen yet. Pick one below — the console will point at it straight away.</div>`}
  </section>

  <section class="card">
    <div class="card-head"><h2>On this network</h2><span class="chip">${scanning ? 'looking…' : `${found.filter(m => m.reachable).length} answering`}</span></div>
    ${found.length
      ? found.filter(m => m.reachable).map(m => row(m, {
        found: true,
        current: Boolean(current && current.id === m.id),
        actions: current && current.id === m.id
          ? '<span class="muted small">in use</span>'
          : `<button class="btn primary sm" data-use="${esc(m.id)}" type="button">Use this</button>`,
      })).join('') || '<div class="empty">Nothing on this network answered. A machine on another network can still be reached by address — see below.</div>'
      : `<div class="empty">${scanning ? 'Looking for printer machines…' : 'No printer machine announced itself. Some networks block discovery; add one by address below.'}</div>`}
  </section>

  <section class="card">
    <div class="card-head"><h2>By address</h2></div>
    <p class="muted small">For a machine across a tailnet or VPN, or on a network that blocks discovery. The address is checked before it is remembered, so a typo cannot send the console somewhere that is not a PrintBridge machine.</p>
    <form class="row wrap" id="conn-form" autocomplete="off">
      <input class="input" id="conn-address" placeholder="192.168.1.20:8088" required>
      <button class="btn" id="conn-check" type="submit">Check and use</button>
    </form>
    <div class="job-error hidden" id="conn-error" style="margin-top:10px"></div>
  </section>

  ${known.length ? `
  <section class="card">
    <div class="card-head"><h2>Remembered</h2><span class="chip">${known.length}</span></div>
    ${known.map(m => row(m, {
      current: Boolean(current && current.id === m.id),
      actions: `${current && current.id === m.id ? '' : `<button class="btn sm" data-use="${esc(m.id)}" type="button">Use this</button>`}
                <button class="btn sm ghost" data-forget="${esc(m.id)}" type="button">Forget</button>`,
    })).join('')}
  </section>` : ''}
  `;

  host.querySelector('#conn-scan')?.addEventListener('click', () => scan());

  host.querySelectorAll('[data-use]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const result = await desktop.machines.use({ id: button.dataset.use }).catch(error => ({ ok: false, error: error.message }));
      if (!result || !result.ok) {
        toast('Could not switch machine', (result && result.error) || '', 'err');
        button.disabled = false;
        return;
      }
      toast('Now working with this machine', result.machine.name, 'ok');
      /* The whole console follows: reload rather than trying to re-point every
       * panel, because every panel's data now comes from a different place. */
      setTimeout(() => window.location.reload(), 400);
    });
  });

  host.querySelectorAll('[data-forget]').forEach((button) => {
    button.addEventListener('click', async () => {
      await desktop.machines.forget(button.dataset.forget).catch(() => null);
      await refresh();
    });
  });

  host.querySelector('#conn-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = host.querySelector('#conn-address');
    const errorBox = host.querySelector('#conn-error');
    const check = host.querySelector('#conn-check');
    errorBox.classList.add('hidden');
    check.disabled = true;
    try {
      const result = await desktop.machines.check({ address: input.value.trim() });
      if (!result.ok) {
        errorBox.textContent = `Nothing answered there — ${result.reason || 'check the address'}.`;
        errorBox.classList.remove('hidden');
        return;
      }
      await desktop.machines.use({ id: result.machine.id });
      toast(`${result.app} ${result.version}`.trim(), 'Connected — reloading the console', 'ok');
      setTimeout(() => window.location.reload(), 600);
    } finally {
      check.disabled = false;
    }
  });
}
