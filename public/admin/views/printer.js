/* Printer view — choose and understand the print path (USB queue or network). */

import { api } from '../api.js';
import { store, refreshPrinter } from '../store.js';
import {
  esc, icon, icons, toast, note, copyText, confirmDialog, emptyState,
} from '../../app/ui.js';

const local = {
  tab: 'usb',
  queues: null,
  netPrinters: null,
  backends: null,
  tools: null,
  loading: null,
  installLog: null,
  discovering: false,
  autoDiscovered: false,
  waking: false,
};

export async function render(container, _params, ctx) {
  if (local.tab === null) local.tab = 'usb';
  if (processPlatformIsWindows()) local.tab = 'usb';
  container.innerHTML = shell();
  bind(container, ctx);

  await Promise.all([loadTools(), loadQueues(), loadBackends()]);
  paint(container, ctx);
  return { update: (type) => { if (['printer', 'connection', 'settings'].includes(type)) paint(container, ctx); } };
}

function processPlatformIsWindows() {
  return (store.state.meta?.platform || '') === 'win32';
}

/* ---------------- data ---------------- */

async function loadTools() {
  try { local.tools = await api.printerTools(); } catch { local.tools = null; }
}

async function loadQueues() {
  try {
    const res = await api.printerLocate({ mdns: false, scan: false });
    local.queues = res.windowsQueues || [];
    local.cupsQueues = res.cupsQueues || [];
    local.subnets = res.subnets || [];
  } catch (e) {
    local.queues = [];
    local.queuesError = e.message;
  }
}

async function loadBackends() {
  try { local.backends = await api.printerBackends(); } catch { local.backends = null; }
}

async function discoverNetwork(scan) {
  local.discovering = true;
  try {
    const res = await api.printerLocate({ mdns: true, scan });
    local.netPrinters = res.networkPrinters || [];
    toast(
      local.netPrinters.length ? `Found ${local.netPrinters.length} printer(s)` : 'No printers found',
      local.netPrinters.length ? '' : 'Make sure the printer is on and on this Wi-Fi',
      local.netPrinters.length ? 'ok' : 'info'
    );
  } catch (e) {
    toast('Discovery failed', e.message, 'err');
  } finally {
    local.discovering = false;
  }
}

/* ---------------- markup ---------------- */

function shell() {
  return `
  <section class="view">
    <div class="view-head">
      <h1>Printer</h1>
      <p>Where jobs go, how they get there, and what to fix when they don't.</p>
    </div>

    <div class="card" id="p-hero"></div>

    <div class="card">
      <div class="card-head">
        <h3>${icon('wrench')} Connection</h3>
        <button class="btn sm ghost" id="p-refresh">${icons.refresh}<span>Refresh</span></button>
      </div>
      <div class="tabs" id="p-tabs" style="margin-bottom:14px">
        <button data-tab="usb">USB queue</button>
        <button data-tab="network">Network</button>
        <button data-tab="auto">Automatic</button>
      </div>
      <div id="p-tab-body"></div>
    </div>

    <div class="card">
      <details class="disclosure">
        <summary>Move the printer to Wi-Fi (then nothing needs to stay plugged in)</summary>
        <div class="disclosure-body">
          <div class="steps">
            <div class="step-item"><b>Your printer supports Wi-Fi.</b> The "w" in Neverstop Laser MFP 1200w means wireless — it can stop living on a USB cable.</div>
            <div class="step-item"><b>One-time setup.</b> In HP Smart (phone or PC) open the printer → <b>Advanced / Network settings</b> → join your 2.4 GHz Wi-Fi, or use the printer's Wi-Fi setup wizard on its panel.</div>
            <div class="step-item"><b>Print the network report</b> from the printer to note the IP address it receives.</div>
            <div class="step-item"><b>Come back here</b> → <b>Network</b> tab → press <b>Find printers</b>, or paste the printer's IP (just <span class="mono">192.168.1.50</span> is enough). Jobs then print over IPP.</div>
            <div class="step-item"><b>Reserve the IP</b> in your router (DHCP reservation) so the address never changes.</div>
            <div class="step-item"><b>Then print from anywhere</b> — Admin → <b>Settings</b> → <b>Print from anywhere</b> walks through the free VPN that lets your phone reach this server from outside the house.</div>
          </div>
          <div style="margin-top:12px">${note('While the printer is on <b>USB</b>, the machine running PrintBridge must stay connected to it by cable — that is a hardware limit, not a software one. Switching to Wi-Fi frees the printer completely.', 'warn')}</div>
        </div>
      </details>
    </div>

    <div class="card" id="p-actions"></div>
  </section>`;
}

function bind(container, ctx) {
  container.querySelectorAll('#p-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      local.tab = btn.dataset.tab;
      paint(container, ctx);
    });
  });
  container.querySelector('#p-refresh').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.classList.add('spin');
    try {
      await refreshPrinter();
      await Promise.all([loadTools(), loadQueues(), loadBackends()]);
      toast('Status refreshed');
    } finally {
      button.classList.remove('spin');
      paint(container, ctx);
    }
  });
}

/* ---------------- paint ---------------- */

function paint(container, ctx) {
  if (!container.querySelector('#p-hero')) return; // view was torn down mid-flight
  paintHero(container, ctx);
  paintTabs(container, ctx);
  paintActions(container, ctx);
}

function paintHero(container, ctx) {
  const host = container.querySelector('#p-hero');
  if (!host) return;
  const printer = store.state.printer;
  if (!printer) {
    host.innerHTML = '<div class="skeleton-block"></div>';
    return;
  }

  const status = printer.state.status;
  const ringIcon = status === 'ready' ? icons.check
    : status === 'busy' ? icons.printer
    : status === 'unconfigured' ? icons.wrench
    : icons.alert;

  const kindIcon = printer.active.kind === 'usb' ? icons.usb
    : printer.active.kind === 'network' ? icons.wifi : icons.folder;

  const markers = (printer.state.markers || []).filter(m => typeof m.level === 'number' && m.level >= 0);

  host.innerHTML = `
    <div class="printer-hero">
      <div class="status-ring ${esc(status)}">${ringIcon}</div>
      <div class="grow" style="min-width:220px">
        <div class="row wrap" style="gap:8px">
          <h2>${esc(printer.state.name || 'Printer')}</h2>
          <span class="chip kind">${esc(printer.active.kind)}</span>
          <span class="chip">${printer.active.id}</span>
          ${printer.state.queueDepth ? `<span class="chip printing">${printer.state.queueDepth} in queue</span>` : ''}
        </div>
        <div class="muted small" style="margin-top:4px">${esc(printer.state.detail || printer.reason || '')}</div>
        ${markers.length ? `<div class="stack" style="margin-top:8px;gap:5px">${markers.map(m => `
          <div class="toner"><span>${esc(m.name)}</span><span class="bar"><i style="width:${Math.max(2, Math.min(100, m.level))}%"></i></span><span>${Math.round(m.level)}%</span></div>
        `).join('')}</div>` : ''}
        <div class="row" style="margin-top:10px;gap:8px;flex-wrap:wrap">
          <span class="chip">${esc(printer.reason || '')}</span>
        </div>
      </div>
      <div class="stack" style="gap:8px;min-width:150px">
        <button class="btn primary" id="p-test">${icons.printer}<span>Print test page</span></button>
        <button class="btn" id="p-qrcard">${icons.scan}<span>Print QR card</span></button>
      </div>
    </div>`;

  host.querySelector('#p-test').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true; button.classList.add('spin');
    try {
      await api.printerTest();
      toast('Test page queued', 'Check the queue for live status');
      ctx.navigate('#/queue');
    } catch (e) {
      toast('Test print failed', e.message, 'err', 7000);
    } finally {
      button.disabled = false; button.classList.remove('spin');
    }
  });

  host.querySelector('#p-qrcard').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true; button.classList.add('spin');
    try {
      await api.printQrCard();
      toast('QR card queued', 'Print it and tape it next to the printer');
    } catch (e) {
      toast('Could not print the card', e.message, 'err');
    } finally {
      button.disabled = false; button.classList.remove('spin');
    }
  });
  void kindIcon;
}

function paintTabs(container, ctx) {
  const host = container.querySelector('#p-tab-body');
  container.querySelectorAll('#p-tabs button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === local.tab);
  });

  if (local.tab === 'usb') return paintUsbTab(host, ctx);
  if (local.tab === 'network') return paintNetworkTab(host, ctx);
  return paintAutoTab(host, ctx);
}

function paintUsbTab(host, ctx) {
  const isWindows = processPlatformIsWindows();
  const tools = local.tools || {};
  const queues = local.queues || [];
  const selected = store.state.settings?.spoolerQueue || '';

  if (!isWindows) {
    host.innerHTML = emptyState({
      iconName: 'usb',
      title: 'USB queues are a Windows feature',
      text: 'On macOS or Linux, use a system (CUPS) queue or connect the printer over the network.',
    });
    return;
  }

  const engineBadge = tools.silentPrintReady
    ? `<span class="chip printed">${esc(tools.sumatra ? 'SumatraPDF' : 'Acrobat')} ready</span>`
    : '<span class="chip failed">helper missing</span>';

  host.innerHTML = `
    <div class="spread wrap" style="margin-bottom:12px">
      <div class="row wrap" style="gap:8px">
        <span class="chip">silent printing</span>${engineBadge}
        ${tools.winget ? '<span class="chip">winget available</span>' : ''}
      </div>
      <button class="btn sm ghost" id="p-rescan">${icons.refresh}<span>Rescan queues</span></button>
    </div>

    ${tools.silentPrintReady ? '' : note('Windows needs a helper to print a PDF without showing a dialog. PrintBridge can install <b>SumatraPDF</b> for you (no extra cost, open source).', 'warn')}

    <div id="p-install-area" style="margin:10px 0"></div>

    <div class="group-label">Windows print queues on this machine</div>
    <div class="pick-list" id="p-queues"></div>`;

  const queueHost = host.querySelector('#p-queues');
  if (!queues.length) {
    queueHost.innerHTML = `<div class="muted small">${esc(local.queuesError || 'No queues found. Is the printer switched on and connected by USB?')}</div>`;
  } else {
    queueHost.innerHTML = queues.map(q => `
      <button class="pick ${q.name === selected ? 'selected' : ''}" data-queue="${esc(q.name)}">
        <span class="icon">${q.kind === 'usb' ? icons.usb : q.kind === 'network' ? icons.wifi : icons.printer}</span>
        <span class="pick-main">
          <span class="pick-name">${esc(q.name)}</span>
          <span class="pick-sub">${esc([q.kind.toUpperCase(), q.driver, q.port].filter(Boolean).join(' · '))}</span>
        </span>
        ${q.recommended ? '<span class="chip printed">recommended</span>' : ''}
        ${q.name === selected ? '<span class="chip printed">selected</span>' : ''}
      </button>`).join('');

    queueHost.querySelectorAll('[data-queue]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.queue;
        try {
          await api.printerSelect({ backend: 'spooler', spoolerQueue: name });
          await api.updateSettings({ spoolerQueue: name }).catch(() => {});
          store.state.settings = { ...(store.state.settings || {}), spoolerQueue: name };
          await refreshPrinter();
          toast('Printer selected', name);
          paint(host.closest('.view') || document.getElementById('view'), ctx);
        } catch (e) {
          toast('Could not select', e.message, 'err');
        }
      });
    });
  }

  host.querySelector('#p-rescan')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.classList.add('spin');
    await Promise.all([loadQueues(), loadTools()]);
    button.classList.remove('spin');
    paint(document.getElementById('view'), ctx);
  });

  if (!tools.silentPrintReady) {
    const area = host.querySelector('#p-install-area');
    const button = document.createElement('button');
    button.className = 'btn primary';
    button.innerHTML = `${icons.download}<span>Install silent print helper</span>`;
    button.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Install SumatraPDF?',
        message: 'PrintBridge will run winget (or download the portable build) so PDFs can be sent to the queue silently.',
        confirmLabel: 'Install',
      });
      if (!ok) return;
      button.disabled = true;
      button.classList.add('spin');
      button.querySelector('span').textContent = 'Installing… this can take a minute';
      try {
        const res = await api.printerInstallHelper();
        local.installLog = res;
        if (res.ok) {
          toast('Helper installed', res.via || '', 'ok');
        } else {
          toast('Automatic install failed', 'See the steps below', 'err', 8000);
        }
      } catch (e) {
        toast('Install failed', e.message, 'err', 8000);
      } finally {
        await loadTools();
        paint(document.getElementById('view'), ctx);
      }
    });
    area.appendChild(button);

    if (local.installLog) {
      const log = document.createElement('div');
      log.innerHTML = `<details class="disclosure" style="margin-top:12px"><summary>Install details</summary><div class="disclosure-body"><div class="log-console">${(local.installLog.steps || []).map(esc).join('<br>') || 'no output'}${local.installLog.hint ? `<br><br><b>${esc(local.installLog.hint)}</b>` : ''}</div></div></details>`;
      area.appendChild(log);
    }
  }
}

function paintNetworkTab(host, ctx) {
  const settings = store.state.settings || {};
  const printers = local.netPrinters || [];
  const current = settings.printerUrl || '';
  const subnets = (local.subnets || []).length ? local.subnets : [];

  host.innerHTML = `
    <div class="field" style="margin-bottom:12px">
      <label for="p-url">Network printer address (IPP)</label>
      <div class="row">
        <input class="input grow" id="p-url" placeholder="ipp://192.168.1.50/ipp/print" value="${esc(current)}" spellcheck="false">
        <button class="btn primary" id="p-url-save">Save</button>
      </div>
      <div class="hint">Find the printer's IP in its network report, or use discovery below.</div>
    </div>

    <div class="row wrap" style="margin-bottom:12px">
      <button class="btn" id="p-find">${icons.scan}<span>Find printers</span></button>
      <button class="btn ghost" id="p-scan">Deep scan subnet</button>
      <button class="btn ghost" id="p-wake">${icons.bolt}<span>Wake printer</span></button>
      ${local.discovering ? '<span class="chip printing">scanning…</span>' : ''}
      ${local.waking ? '<span class="chip printing">waking…</span>' : ''}
    </div>
    <div class="hint" style="margin:-4px 0 12px">Wi-Fi printers doze between jobs; <b>Wake printer</b> sends a nudge now, and every job does the same thing automatically.</div>

    <div class="pick-list" id="p-net-list"></div>

    <div class="field" style="margin-top:16px">
      <label for="p-keepalive">Keep-alive (minutes, 0 = off)</label>
      <div class="row">
        <input class="input" id="p-keepalive" type="number" min="0" max="240" value="${Number(settings.keepAliveMinutes) || 0}" style="max-width:120px">
        <button class="btn" id="p-keepalive-save">Save</button>
      </div>
      <div class="hint">Pings the printer on a schedule so Wi-Fi deep-sleep never drops it.</div>
    </div>`;

  const listHost = host.querySelector('#p-net-list');
  if (!printers.length) {
    listHost.innerHTML = `<div class="muted small">${subnets.length ? `Local networks: ${subnets.map(s => esc(s + '0/24')).join(', ')}` : 'Run a discovery to list printers.'}</div>`;
  } else {
    listHost.innerHTML = printers.map((p, i) => `
      <button class="pick" data-net="${i}">
        <span class="icon">${p.kind === 'raw' ? icons.printer : icons.wifi}</span>
        <span class="pick-main">
          <span class="pick-name">${esc(p.name || p.host)}</span>
          <span class="pick-sub">${esc(p.url)}${p.via ? ` · ${esc(p.via)}` : ''}</span>
        </span>
        <span class="chip">${esc(p.kind)}</span>
      </button>`).join('');

    listHost.querySelectorAll('[data-net]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const printer = printers[Number(btn.dataset.net)];
        if (printer.kind === 'raw') {
          toast('RAW-only printer found', 'This printer does not advertise IPP — try its IPP address instead', 'info', 6000);
          return;
        }
        try {
          await api.printerSelect({ backend: 'ipp', printerUrl: printer.url });
          await api.updateSettings({ printerUrl: printer.url }).catch(() => {});
          await refreshPrinter();
          toast('Connected', printer.url);
        } catch (e) {
          toast('Could not connect', e.message, 'err');
        }
      });
    });
  }

  host.querySelector('#p-url-save').addEventListener('click', async () => {
    const url = host.querySelector('#p-url').value.trim();
    try {
      await api.printerSelect({ backend: 'ipp', printerUrl: url });
      await refreshPrinter();
      toast(url ? 'Address saved' : 'Address cleared');
    } catch (e) {
      toast('Invalid address', e.message, 'err');
    }
  });

  host.querySelector('#p-find').addEventListener('click', async () => {
    await discoverNetwork(false);
    paint(document.getElementById('view'), ctx);
  });

  host.querySelector('#p-wake').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    local.waking = true;
    button.disabled = true;
    try {
      const res = await api.printerWake();
      if (res.ok) toast('Printer answered', `${res.name || ''}${res.ms ? ` · ${res.ms} ms` : ''}`);
      else toast('No answer from the printer', res.error || '', 'err', 7000);
      await refreshPrinter();
    } catch (e) {
      toast('Wake failed', e.message, 'err');
    } finally {
      local.waking = false;
      button.disabled = false;
      paint(document.getElementById('view'), ctx);
    }
  });
  host.querySelector('#p-scan').addEventListener('click', async (event) => {
    const ok = await confirmDialog({
      title: 'Deep scan the subnet?',
      message: 'This probes every address on your local network for print services. It takes a few seconds.',
      confirmLabel: 'Scan',
    });
    if (!ok) return;
    event.currentTarget.classList.add('spin');
    await discoverNetwork(true);
    paint(document.getElementById('view'), ctx);
  });
  // Opening the Network tab with nothing configured should show nearby
  // printers on its own — Wi-Fi setup is "plug it in and pick it", not a hunt.
  if (!current && !printers.length && !local.discovering && !local.autoDiscovered) {
    local.autoDiscovered = true;
    discoverNetwork(false).then(() => paint(document.getElementById('view'), ctx));
  }

  host.querySelector('#p-keepalive-save').addEventListener('click', async () => {
    const minutes = Number(host.querySelector('#p-keepalive').value) || 0;
    try {
      const all = await api.updateSettings({ keepAliveMinutes: minutes });
      store.state.settings = all;
      toast(minutes ? `Keep-alive every ${minutes} min` : 'Keep-alive off');
    } catch (e) {
      toast('Could not save', e.message, 'err');
    }
  });
}

function paintAutoTab(host, ctx) {
  const backends = local.backends?.backends || [];
  const printer = store.state.printer;
  const selected = local.backends?.selected || 'auto';

  host.innerHTML = `
    ${note('In <b>automatic</b> mode PrintBridge picks the first working path: Windows USB queue → network printer → CUPS → outbox. Pin one below to override.', 'info')}
    <div class="pick-list" style="margin-top:12px">
      <button class="pick ${selected === 'auto' ? 'selected' : ''}" data-backend="auto">
        <span class="icon">${icons.bolt}</span>
        <span class="pick-main">
          <span class="pick-name">Automatic (recommended)</span>
          <span class="pick-sub">${esc(printer ? printer.reason : 'resolving…')}</span>
        </span>
        ${selected === 'auto' ? '<span class="chip printed">active</span>' : ''}
      </button>
      ${backends.map(b => `
        <button class="pick ${selected === b.id ? 'selected' : ''}" data-backend="${esc(b.id)}">
          <span class="icon">${b.kind === 'usb' ? icons.usb : b.kind === 'network' ? icons.wifi : b.kind === 'local' ? icons.folder : icons.printer}</span>
          <span class="pick-main">
            <span class="pick-name">${esc(b.label)}</span>
            <span class="pick-sub">${b.available ? 'available now' : 'not available right now'}</span>
          </span>
          <span class="chip ${b.available ? 'printed' : 'canceled'}">${b.available ? 'ready' : 'off'}</span>
        </button>`).join('')}
    </div>`;

  host.querySelectorAll('[data-backend]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api.printerSelect({ backend: btn.dataset.backend });
        await refreshPrinter();
        await loadBackends();
        toast('Print path updated', btn.dataset.backend);
        paint(document.getElementById('view'), ctx);
      } catch (e) {
        toast('Could not switch', e.message, 'err');
      }
    });
  });
}

function paintActions(container, ctx) {
  const host = container.querySelector('#p-actions');
  const printer = store.state.printer;
  const diag = store.state.meta;
  host.innerHTML = `
    <div class="card-head"><h3>${icon('info')} This server</h3></div>
    <div class="tile-grid">
      <div class="tile"><div class="k">Platform</div><div class="v">${esc((diag?.platform || '') + ' · ' + (diag?.arch || ''))}</div></div>
      <div class="tile"><div class="k">Node</div><div class="v small">${esc(diag?.node || '')}</div></div>
      <div class="tile"><div class="k">Address</div><div class="v small">${esc(store.state.meta?.lanUrl || location.origin)}</div></div>
      <div class="tile"><div class="k">Silent print</div><div class="v">${local.tools?.silentPrintReady ? 'ready' : (processPlatformIsWindows() ? 'missing' : 'n/a')}</div></div>
      <div class="tile"><div class="k">Office docs</div><div class="v">${local.tools?.libreoffice ? 'LibreOffice' : 'not installed'}</div></div>
      <div class="tile"><div class="k">Print path</div><div class="v">${esc(printer?.active.id || '—')}</div></div>
    </div>
    <div class="row" style="margin-top:12px;flex-wrap:wrap">
      <button class="btn sm ghost" id="p-copy">${icons.copy}<span>Copy server address</span></button>
      <a class="btn sm ghost" href="#/settings">${icons.list}<span>Diagnostics &amp; logs</span></a>
    </div>`;

  host.querySelector('#p-copy').addEventListener('click', () => {
    copyText(store.state.meta?.lanUrl || location.origin, 'Address copied');
  });
  void ctx;
}
