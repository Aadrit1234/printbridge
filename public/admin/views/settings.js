/* Settings view — pairing, defaults, appearance, diagnostics. */

import { api } from '../api.js';
import { store, applySettings } from '../store.js';
import { applyTheme, currentTheme } from '../../app/theme.js';
import {
  esc, icon, icons, toast, note, copyText, confirmDialog, fmtBytes, fmtAgo,
} from '../../app/ui.js';

let diagnostics = null;
let logs = [];
let defaults = null;
let remoteInfo = null;
let remoteCheck = null;

export async function render(container, _params, ctx) {
  container.innerHTML = shell();
  bind(container, ctx);
  logs = [...(store.state.logs || [])];
  paintLogs(container);
  paintDefaults(container);
  paintTheme(container);
  paintRemote(container);
  loadRemote(container);

  try {
    diagnostics = await api.diagnostics();
    paintDiagnostics(container);
  } catch { /* diagnostics are optional */ }

  return {
    update: (type) => {
      if (type === 'log') {
        const last = store.state.logs[store.state.logs.length - 1];
        if (last) { logs.push(last); if (logs.length > 200) logs.shift(); paintLogs(container); }
      }
      if (type === 'settings') { paintDefaults(container); paintTheme(container); paintRemote(container); }
      if (['printer', 'connection'].includes(type)) { /* hero is on the printer page */ }
    },
  };
}

function shell() {
  return `
  <section class="view">
    <div class="view-head">
      <h1>Settings</h1>
      <p>Share the printer, set defaults, and see what the server is doing.</p>
    </div>

    <div class="card">
      <div class="card-head"><h3>${icon('scan')} Share this printer</h3></div>
      <div class="qr-block">
        <div class="qr-frame"><img id="s-qr" alt="QR code to open PrintBridge"></div>
        <div class="url-pill"><code id="s-url">${esc(store.state.meta?.lanUrl || location.origin)}</code>
          <button class="icon-btn" id="s-copy" title="Copy">${icons.copy}</button>
        </div>
        <p class="muted small" style="max-width:44ch">Anyone on this Wi-Fi can scan this code, upload a file and print. No app, no account.</p>
        <div class="row wrap" style="justify-content:center">
          <a class="btn" href="${api.cardUrl()}" target="_blank" rel="noopener">${icons.download}<span>QR poster (A4 PDF)</span></a>
          <button class="btn primary" id="s-print-card">${icons.printer}<span>Print QR card now</span></button>
        </div>
      </div>
    </div>

    <div class="card" id="s-remote-card">
      <div class="card-head">
        <h3>${icons.globe} Print from anywhere</h3>
        <button class="btn sm ghost" id="s-remote-refresh">${icons.refresh}<span>Re-check</span></button>
      </div>
      <div id="s-remote-body"><div class="skeleton-block"></div></div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="card-head"><h3>${icon('printer')} Print defaults</h3></div>
        <div id="s-defaults" class="stack"></div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><h3>${icon('moon')} Appearance</h3></div>
          <div class="segmented" id="s-theme">
            <button data-theme="system">System</button>
            <button data-theme="dark">Dark</button>
            <button data-theme="light">Light</button>
          </div>
          <div class="hint" style="margin-top:8px">The theme is stored on this device.</div>
        </div>

        <div class="card">
          <div class="card-head"><h3>${icon('info')} Diagnostics</h3>
            <button class="icon-btn" id="s-refresh" title="Refresh">${icons.refresh}</button>
          </div>
          <div id="s-diag"><div class="skeleton-block"></div></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>${icon('list')} Server log</h3>
        <div class="row" style="gap:6px">
          <span class="chip" id="s-conn">connecting</span>
          <button class="btn sm ghost" id="s-clear-log">Clear view</button>
        </div>
      </div>
      <div class="log-console" id="s-logs"></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>${icon('shield')} About &amp; safety</h3></div>
      <div class="tile-grid">
        <div class="tile"><div class="k">Version</div><div class="v">${esc(store.state.meta?.app || 'PrintBridge')} ${esc(store.state.meta?.version || '')}</div></div>
        <div class="tile"><div class="k">Host</div><div class="v small">${esc(store.state.meta?.hostname || '')}</div></div>
        <div class="tile"><div class="k">Node</div><div class="v small">${esc(store.state.meta?.node || '')}</div></div>
        <div class="tile"><div class="k">Uptime</div><div class="v" id="s-uptime">—</div></div>
      </div>
      <div style="margin-top:12px">${note('This server is meant for a trusted home or office network: anyone who can reach it can print. Expose it to the internet only behind a VPN (Tailscale) or an authenticating proxy.', 'warn')}</div>
    </div>
  </section>`;
}

function bind(container, ctx) {
  const url = store.state.meta?.lanUrl || location.origin;
  const qr = container.querySelector('#s-qr');
  if (qr) qr.src = api.qrUrl(location.origin) + `&t=${Date.now()}`;

  container.querySelector('#s-copy').addEventListener('click', () => copyText(url, 'Address copied'));

  container.querySelector('#s-print-card').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true; button.classList.add('spin');
    try {
      await api.printQrCard();
      toast('QR card queued', 'It prints through the normal queue');
      ctx.navigate('#/queue');
    } catch (e) {
      toast('Could not print the card', e.message, 'err');
    } finally {
      button.disabled = false; button.classList.remove('spin');
    }
  });

  container.querySelectorAll('#s-theme button').forEach(btn => {
    btn.addEventListener('click', () => {
      applyTheme(btn.dataset.theme);
      paintTheme(container);
      toast(`Theme: ${btn.dataset.theme}`, '', 'info', 2000);
    });
  });

  container.querySelector('#s-refresh').addEventListener('click', async () => {
    try {
      diagnostics = await api.diagnostics();
      paintDiagnostics(container);
      toast('Diagnostics refreshed');
    } catch (e) {
      toast('Could not refresh', e.message, 'err');
    }
  });

  container.querySelector('#s-clear-log').addEventListener('click', () => {
    logs = [];
    paintLogs(container);
  });
}

/* ---------------- print from anywhere ---------------- */

async function loadRemote(container, { fresh = false } = {}) {
  try {
    remoteInfo = await api.remoteInfo(fresh);
  } catch (e) {
    remoteInfo = { error: e.message };
  }
  paintRemote(container);
}

function remoteState(info) {
  const ts = info.tailscale || {};
  if (ts.up && ts.url) return { cls: 'printed', label: 'ready', text: 'This server has an address you can reach from outside your home network.' };
  if (ts.up && !ts.dnsName) return { cls: 'printing', label: 'IP only', text: 'A Tailscale link is up, but this machine has no stable name yet — run "tailscale up" so the address stops changing.' };
  if (ts.installed && !ts.up) return { cls: 'queued', label: 'signed out', text: 'Tailscale is installed but not connected. Run "tailscale up" on this machine.' };
  if (ts.state === 'cli-not-found') return { cls: 'queued', label: 'via the interface', text: 'A Tailscale address exists on this machine, but the command line tool was not found, so the name cannot be read.' };
  return { cls: 'canceled', label: 'LAN only', text: 'Right now this server only answers on your own network. Follow the steps below to print from anywhere.' };
}

function paintRemote(container) {
  const host = container.querySelector('#s-remote-body');
  if (!host) return;
  if (!remoteInfo) { host.innerHTML = '<div class="skeleton-block"></div>'; return; }
  if (remoteInfo.error) { host.innerHTML = note(`Could not read the network status: ${esc(remoteInfo.error)}`, 'warn'); return; }

  const info = remoteInfo;
  const ts = info.tailscale || {};
  const state = remoteState(info);
  const settings = store.state.settings || {};
  const lan = info.lan || [];

  host.innerHTML = `
    <div class="row wrap" style="gap:8px;margin-bottom:12px">
      <span class="chip ${state.cls}">${esc(state.label)}</span>
      ${info.url ? `<span class="chip">${esc(info.source === 'configured' ? 'your address' : 'detected')}</span>` : ''}
      ${ts.up ? '<span class="chip printed">tailscale up</span>' : '<span class="chip canceled">no VPN</span>'}
    </div>
    <p class="muted small" style="margin:0 0 14px">${esc(state.text)}</p>

    <div class="group-label">On this network</div>
    <div class="stack" style="gap:6px;margin-bottom:14px">
      ${lan.length
        ? lan.map(a => `
          <div class="spread">
            <code class="mono small">${esc(a.url)}</code>
            <button class="btn sm ghost" data-copy="${esc(a.url)}">${icons.copy}<span>Copy</span></button>
          </div>`).join('')
        : '<div class="muted small">No local network address found.</div>'}
    </div>

    <div class="field" style="margin-bottom:14px">
      <label for="s-remote-url">Address to print from away (http:// or https://)</label>
      <div class="row">
        <input class="input grow" id="s-remote-url" spellcheck="false"
          placeholder="${esc(ts.dnsName ? `http://${ts.dnsName}:${info.port}` : `http://${ts.ip || 'your-vpn-name'}:${info.port}`)}"
          value="${esc(settings.remoteUrl || '')}">
        <button class="btn primary" id="s-remote-save">Save</button>
      </div>
      <div class="hint">${info.url && info.source === 'tailscale'
        ? `Empty means: use the detected Tailscale address — <span class="mono">${esc(info.url)}</span>.`
        : 'Set this once you have a VPN name or a tunnel hostname. The QR card below will point at it.'}</div>
    </div>

    ${info.url ? `<div class="spread wrap" style="margin-bottom:12px;gap:8px">
      <code class="mono small">${esc(info.url)}</code>
      <button class="btn sm ghost" data-copy="${esc(info.url)}">${icons.copy}<span>Copy</span></button>
    </div>` : ''}

    <div class="row wrap" style="gap:8px;margin-bottom:14px">
      <button class="btn" id="s-remote-test">${icons.globe}<span>Test from here</span></button>
      ${info.url ? `<a class="btn ghost" href="${api.cardUrl('remote')}" target="_blank" rel="noopener">${icons.download}<span>QR card for the road</span></a>` : ''}
      ${info.url ? `<button class="btn ghost" id="s-remote-print-card">${icons.printer}<span>Print that card</span></button>` : ''}
      ${remoteCheck ? `<span class="chip ${remoteCheck.ok ? 'printed' : 'failed'}">${remoteCheck.ok ? `answered in ${remoteCheck.ms} ms` : esc(remoteCheck.error || 'no answer')}</span>` : ''}
    </div>

    <div class="field" style="margin-bottom:14px">
      <label for="s-retry-window">Keep trying for (minutes)</label>
      <div class="row">
        <input class="input" id="s-retry-window" type="number" min="0" max="720" style="max-width:120px" value="${Number(settings.retryWindowMinutes) || 0}">
        <button class="btn" id="s-retry-save">Save</button>
      </div>
      <div class="hint">A job sent from your phone keeps retrying this long if the printer is asleep or off, then fails. <b>0</b> turns that off (one attempt, then failed).</div>
    </div>

    <details class="disclosure">
      <summary>${ts.up ? 'How to use this from another device' : 'Set it up (one time, free)'}</summary>
      <div class="disclosure-body">
        <div class="steps">
          <div class="step-item"><b>Install Tailscale</b> on the machine that runs PrintBridge (<span class="mono">tailscale.com/download</span>, free for personal use) and sign in.</div>
          <div class="step-item"><b>Install the Tailscale app</b> on the phone or laptop you print from, with the same account. Those devices now see each other privately — nothing is opened to the public internet.</div>
          <div class="step-item"><b>Come back here and press Re-check.</b> The Tailscale address appears above — that address works from anywhere, at home or on 4G.</div>
          <div class="step-item"><b>Optional HTTPS:</b> on the server run <span class="mono">tailscale serve --bg ${info.port}</span>, then save the <span class="mono">https://…</span> address it prints here.</div>
          <div class="step-item"><b>Let the box run itself:</b> start PrintBridge at boot (Task Scheduler, systemd, or launchd) so the printer is always reachable — see <span class="mono">docs/anywhere-access.md</span>.</div>
        </div>
        ${note('Anyone who can reach this server can print — keep the admin PIN on, and prefer a private VPN (Tailscale) over opening a router port.', 'warn')}
      </div>
    </details>`;

  host.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => copyText(btn.dataset.copy, 'Address copied'));
  });

  host.querySelector('#s-remote-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const value = host.querySelector('#s-remote-url').value.trim();
    button.disabled = true;
    try {
      const all = await api.updateSettings({ remoteUrl: value });
      store.state.settings = all;
      remoteCheck = null;
      await loadRemote(container, { fresh: true });
      toast(value ? 'Remote address saved' : 'Using the detected address');
    } catch (e) {
      toast('Could not save', e.message, 'err');
    } finally {
      button.disabled = false;
    }
  });

  host.querySelector('#s-remote-test').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true; button.classList.add('spin');
    try {
      const res = await api.checkRemote(store.state.settings?.remoteUrl || '');
      remoteCheck = res;
      if (res.snapshot) remoteInfo = res.snapshot;
      paintRemote(container);
      toast(res.ok ? 'That address answered' : 'No answer from that address', res.ok ? res.url : (res.error || ''), res.ok ? 'ok' : 'err', 8000);
    } catch (e) {
      toast('Check failed', e.message, 'err');
    } finally {
      button.disabled = false; button.classList.remove('spin');
    }
  });

  const refresh = container.querySelector('#s-remote-refresh');
  if (refresh && !refresh.dataset.bound) {
    refresh.dataset.bound = '1';
    refresh.addEventListener('click', async () => {
      remoteCheck = null;
      await loadRemote(container, { fresh: true });
      toast('Network status refreshed');
    });
  }

  host.querySelector('#s-retry-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const minutes = Number(host.querySelector('#s-retry-window').value) || 0;
    button.disabled = true;
    try {
      const all = await api.updateSettings({ retryWindowMinutes: minutes });
      store.state.settings = all;
      toast(minutes ? `Sleeping-printer jobs keep trying for ${minutes} min` : 'Sleeping-printer retries off');
    } catch (e) {
      toast('Could not save', e.message, 'err');
    } finally {
      button.disabled = false;
    }
  });

  host.querySelector('#s-remote-print-card')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api.printQrCard('remote');
      toast('Card queued', 'It prints through the normal queue');
    } catch (e) {
      toast('Could not print the card', e.message, 'err');
    } finally {
      button.disabled = false;
    }
  });
}

/* ---------------- defaults ---------------- */

function paintDefaults(container) {
  const host = container.querySelector('#s-defaults');
  const settings = store.state.settings;
  if (!host || !settings) return;
  const papers = settings.papers || {};

  host.innerHTML = `
    <div class="field">
      <label>Paper size</label>
      <select class="input" id="d-paper">
        ${Object.entries(papers).map(([key, def]) => `<option value="${esc(key)}" ${settings.paper === key ? 'selected' : ''}>${esc(def.label)}${def.mm ? ` · ${def.mm[0]}×${def.mm[1]} mm` : ''}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label>Default copies</label>
      <div class="stepper">
        <button id="d-copies-minus">${icons.minus}</button>
        <output id="d-copies">${Number(settings.copies) || 1}</output>
        <button id="d-copies-plus">${icons.plus}</button>
      </div>
    </div>
    <div class="field">
      <label>Scaling</label>
      <div class="segmented" id="d-scale">
        <button data-scale="fit" class="${settings.scale === 'fit' ? 'active' : ''}">Fit to page</button>
        <button data-scale="actual" class="${settings.scale === 'actual' ? 'active' : ''}">Actual size</button>
      </div>
    </div>
    <div class="field">
      <label>Two-sided by default</label>
      <label class="switch">
        <input type="checkbox" id="d-duplex" ${settings.duplex ? 'checked' : ''}>
        <span class="track"></span>
        <span class="switch-label">${settings.duplex ? 'On' : 'Off'}</span>
      </label>
    </div>
    <div class="row" style="gap:12px;flex-wrap:wrap">
      <div class="field" style="flex:1;min-width:120px">
        <label>Max upload (MB)</label>
        <input class="input" id="d-upload" type="number" min="1" max="200" value="${Number(settings.maxUploadMb) || 25}">
      </div>
      <div class="field" style="flex:1;min-width:120px">
        <label>Keep history (hours)</label>
        <input class="input" id="d-retention" type="number" min="1" max="720" value="${Number(settings.retentionHours) || 48}">
      </div>
      <div class="field" style="flex:1;min-width:120px">
        <label>Preview page limit</label>
        <input class="input" id="d-preview" type="number" min="1" max="200" value="${Number(settings.maxPreviewPages) || 40}">
      </div>
    </div>
    <button class="btn primary" id="d-save">${icons.check}<span>Save defaults</span></button>`;

  const copiesOut = host.querySelector('#d-copies');
  const bump = (d) => {
    copiesOut.textContent = String(Math.max(1, Math.min(50, (Number(copiesOut.textContent) || 1) + d)));
  };
  host.querySelector('#d-copies-minus').addEventListener('click', () => bump(-1));
  host.querySelector('#d-copies-plus').addEventListener('click', () => bump(1));
  host.querySelectorAll('#d-scale button').forEach(btn => {
    btn.addEventListener('click', () => {
      host.querySelectorAll('#d-scale button').forEach(b => b.classList.toggle('active', b === btn));
    });
  });
  const duplex = host.querySelector('#d-duplex');
  duplex.addEventListener('change', () => {
    duplex.parentElement.querySelector('.switch-label').textContent = duplex.checked ? 'On' : 'Off';
  });

  host.querySelector('#d-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const all = await api.updateSettings({
        paper: host.querySelector('#d-paper').value,
        copies: Number(copiesOut.textContent) || 1,
        scale: host.querySelector('#d-scale button.active')?.dataset.scale || 'fit',
        duplex: host.querySelector('#d-duplex').checked,
        maxUploadMb: Number(host.querySelector('#d-upload').value) || 25,
        retentionHours: Number(host.querySelector('#d-retention').value) || 48,
        maxPreviewPages: Number(host.querySelector('#d-preview').value) || 40,
      });
      applySettings(all);
      toast('Defaults saved');
    } catch (e) {
      toast('Could not save', e.message, 'err');
    } finally {
      button.disabled = false;
    }
  });
}

/* ---------------- theme ---------------- */

function paintTheme(container) {
  const active = currentTheme();
  container.querySelectorAll('#s-theme button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === active);
  });
}

/* ---------------- diagnostics ---------------- */

function paintDiagnostics(container) {
  const host = container.querySelector('#s-diag');
  if (!host || !diagnostics) return;
  const d = diagnostics;
  const dirs = Object.entries(d.storage?.dirs || {});
  const total = d.storage?.totalBytes || 1;

  host.innerHTML = `
    <div class="tile-grid">
      <div class="tile"><div class="k">Print path</div><div class="v">${esc(d.activeBackend.id)}</div></div>
      <div class="tile"><div class="k">Silent engine</div><div class="v">${d.tools.silentPrintReady ? 'ready' : 'missing'}</div></div>
      <div class="tile"><div class="k">LibreOffice</div><div class="v">${d.tools.libreoffice ? 'yes' : 'no'}</div></div>
      <div class="tile"><div class="k">Stored jobs</div><div class="v">${d.storage?.jobs ?? 0}</div></div>
    </div>
    <div class="muted small" style="margin:12px 0 6px">Disk usage · ${fmtBytes(d.storage?.totalBytes || 0)}</div>
    <div class="usage-bars">
      ${dirs.map(([name, info]) => `
        <div class="usage-row">
          <span class="muted">${esc(name)}</span>
          <span class="usage-bar"><i style="width:${Math.max(1, Math.round((info.bytes / total) * 100))}%"></i></span>
          <span class="usage-val">${fmtBytes(info.bytes)} · ${info.files}</span>
        </div>`).join('')}
    </div>
    <div class="row" style="margin-top:12px;flex-wrap:wrap">
      <button class="btn sm ghost" id="s-cleanup">${icons.trash}<span>Run cleanup</span></button>
      <button class="btn sm ghost" id="s-clear-jobs">Clear finished jobs</button>
    </div>
    <div class="hint" style="margin-top:8px">Uptime ${Math.round(d.uptimeSeconds || 0)}s · outbox ${esc(d.outbox || '')}</div>`;

  const uptime = container.querySelector('#s-uptime');
  if (uptime) {
    const secs = Math.round(d.uptimeSeconds || 0);
    uptime.textContent = secs > 3600 ? `${(secs / 3600).toFixed(1)} h` : secs > 60 ? `${Math.round(secs / 60)} min` : `${secs}s`;
  }

  host.querySelector('#s-cleanup').addEventListener('click', async () => {
    try {
      const res = await api.cleanupStorage();
      toast(`Cleanup done`, `${res.removed} job file(s) removed`);
      diagnostics = await api.diagnostics();
      paintDiagnostics(container);
    } catch (e) {
      toast('Cleanup failed', e.message, 'err');
    }
  });

  host.querySelector('#s-clear-jobs').addEventListener('click', async () => {
    const finished = store.jobList().filter(j => !['uploading', 'converting', 'queued', 'printing'].includes(j.status));
    if (!finished.length) return toast('Nothing to clear', '', 'info');
    const ok = await confirmDialog({
      title: `Clear ${finished.length} finished job(s)?`,
      message: 'History entries and their files are removed from the server.',
      confirmLabel: 'Clear',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api.clearFinished();
      for (const job of finished) store.state.jobs.delete(job.id);
      store.emit('jobDeleted');
      toast(`Cleared ${res.removed} job(s)`);
    } catch (e) {
      toast('Could not clear', e.message, 'err');
    }
  });
}

/* ---------------- logs ---------------- */

function paintLogs(container) {
  const host = container.querySelector('#s-logs');
  if (!host) return;
  const conn = container.querySelector('#s-conn');
  if (conn) {
    const live = store.state.connection === 'live';
    conn.className = `chip ${live ? 'live' : 'offline'}`;
    conn.textContent = live ? 'live' : 'reconnecting…';
  }
  if (!logs.length) {
    host.innerHTML = '<div class="muted small">No log entries yet.</div>';
    return;
  }
  const near = host.scrollTop + host.clientHeight > host.scrollHeight - 40;
  host.innerHTML = logs.slice(-200).map(entry => `
    <div class="log-line">
      <span class="t">${esc(new Date(entry.at).toLocaleTimeString())}</span>
      <span class="l-${esc(entry.level)}">${esc(entry.scope || '')}</span>
      <span class="m">${esc(entry.message)}</span>
    </div>`).join('');
  if (near) host.scrollTop = host.scrollHeight;
  void fmtAgo;
}
