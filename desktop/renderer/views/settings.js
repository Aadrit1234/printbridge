/* Settings — sharing, defaults, unattended printing, diagnostics.
 *
 * There is no "print from anywhere" here any more: this server is a thing on
 * your own network, and the console says so plainly. What remains that is
 * genuinely useful for unattended printing is the retry window — how long a job
 * keeps trying when the printer is asleep.
 */

import { api } from '../api.js';
import { store, applySettings } from '../store.js';
import { applyTheme, currentTheme } from '../../app/theme.js';
import {
  esc, icon, icons, toast, note, copyText, confirmDialog, fmtBytes, fmtAgo,
} from '../../app/ui.js';

let diagnostics = null;
let logs = [];

export async function render(container, _params, ctx) {
  container.innerHTML = shell();
  bind(container, ctx);
  logs = [...(store.state.logs || [])];
  paintLogs(container);
  paintDefaults(container);
  paintTheme(container);
  paintNetwork(container);

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
      if (type === 'settings') { paintDefaults(container); paintTheme(container); paintNetwork(container); }
      if (type === 'printer') paintNetwork(container);
    },
  };
}

function shell() {
  return `
  <section class="view">
    <div class="view-head">
      <h1>Settings</h1>
      <p>Share the printer, choose the house defaults, and see what the server is doing.</p>
    </div>

    <div class="card">
      <div class="card-head"><h3>${icon('scan')} Share this printer</h3></div>
      <div class="qr-panel">
        <div class="qr-frame"><img id="s-qr" alt="QR code to open PrintBridge"></div>
        <div class="stack" style="flex:1;min-width:240px">
          <p>Anyone on this Wi-Fi can scan the code, upload a file, pick the printer and print. No app, no account — and no admin access: the guest page cannot see the queue or these settings.</p>
          <div class="url-pill"><code id="s-url">${esc(store.state.meta?.lanUrl || location.origin)}</code>
            <button class="icon-btn" id="s-copy" title="Copy">${icons.copy}</button>
          </div>
          <div class="row wrap">
            <a class="btn" href="${api.cardUrl()}" target="_blank" rel="noopener">${icons.download}<span>QR poster (A4 PDF)</span></a>
            <button class="btn primary" id="s-print-card">${icons.printer}<span>Print QR card now</span></button>
          </div>
        </div>
      </div>
    </div>

    <div class="card" id="s-network-card">
      <div class="card-head"><h3>${icons.wifi} Network &amp; unattended printing</h3></div>
      <div id="s-network"></div>
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
          <div class="card-head">
            <h3>${icon('info')} Diagnostics</h3>
            <span class="grow"></span>
            <button class="icon-btn" id="s-refresh" title="Refresh">${icons.refresh}</button>
          </div>
          <div id="s-diag"><div class="skeleton-block" style="height:140px"></div></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>${icon('list')} Server log</h3>
        <span class="grow"></span>
        <span class="chip" id="s-conn">connecting</span>
        <button class="btn sm ghost" id="s-clear-log">Clear view</button>
      </div>
      <div class="log-console" id="s-logs"></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>${icon('shield')} About &amp; safety</h3></div>
      <div class="tile-grid">
        <div class="tile"><div class="k small muted">Version</div><div class="v">${esc(store.state.meta?.app || 'PrintBridge')} ${esc(store.state.meta?.version || '')}</div></div>
        <div class="tile"><div class="k small muted">Host</div><div class="v small">${esc(store.state.meta?.hostname || '')}</div></div>
        <div class="tile"><div class="k small muted">Node</div><div class="v small">${esc(store.state.meta?.node || '')}</div></div>
        <div class="tile"><div class="k small muted">Uptime</div><div class="v" id="s-uptime">—</div></div>
      </div>
      <div style="margin-top:14px">${note('This server prints for anyone who can reach it on your network. Keep the admin PIN on, and do not forward a router port to it — the guest page is meant for people on the same Wi-Fi as the printer.', 'warn')}</div>
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
    button.disabled = true;
    try {
      await api.printQrCard();
      toast('QR card queued', 'It prints through the normal queue');
      ctx.navigate('#/queue');
    } catch (e) {
      toast('Could not print the card', e.message, 'err');
    } finally {
      button.disabled = false;
    }
  });

  container.querySelectorAll('#s-theme button').forEach(btn => {
    btn.addEventListener('click', () => {
      applyTheme(btn.dataset.theme);
      paintTheme(container);
      toast(`Theme: ${btn.dataset.theme}`, '', 'info', 1800);
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

/* ---------------- network ---------------- */

function paintNetwork(container) {
  const host = container.querySelector('#s-network');
  if (!host) return;
  const settings = store.state.settings || {};
  const meta = store.state.meta || {};
  const addresses = meta.addresses || (meta.lanUrl ? [meta.lanUrl] : [location.origin]);
  const printer = store.state.printer;

  host.innerHTML = `
    <div class="group-label">Reachable at</div>
    <div class="stack" style="gap:8px">
      ${addresses.map(a => `
        <div class="spread wrap">
          <code class="mono small">${esc(a)}</code>
          <button class="btn sm ghost" data-copy="${esc(a)}">${icons.copy}<span>Copy</span></button>
        </div>`).join('')}
    </div>
    <div class="hint" style="margin-top:8px">These are the addresses that work on this network. People scan the QR code above, or type one of these.</div>

    <div class="field" style="margin-top:18px">
      <label for="s-retry-window">Keep trying for (minutes)</label>
      <div class="row">
        <input class="input" id="s-retry-window" type="number" min="0" max="720" style="max-width:120px" value="${Number(settings.retryWindowMinutes) || 0}">
        <button class="btn" id="s-retry-save">${icons.check}<span>Save</span></button>
      </div>
      <div class="hint">
        If the printer is asleep, off, or drops off the network when someone prints, the job waits and retries for this
        long (5 s → 2 min between attempts) and then comes out by itself when the printer is back. <b>0</b> means one attempt, then failed.
      </div>
    </div>

    <div style="margin-top:16px">
      ${printer && printer.active && printer.active.id === 'outbox'
        ? note('No printer is connected right now, so prints are saved as ready-to-print PDFs instead of being sent. Set one up on the <b>Printer</b> page.', 'warn')
        : note(`Printing through <b>${esc(printer && printer.active ? printer.active.label : 'the default path')}</b>.`, 'ok')}
    </div>`;

  host.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => copyText(btn.dataset.copy, 'Address copied'));
  });

  host.querySelector('#s-retry-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const minutes = Number(host.querySelector('#s-retry-window').value) || 0;
    button.disabled = true;
    try {
      const all = await api.updateSettings({ retryWindowMinutes: minutes });
      applySettings(all);
      toast(minutes ? `Jobs keep trying for ${minutes} min` : 'Retries off — one attempt per job');
    } catch (e) {
      toast('Could not save', e.message, 'err');
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
      <label for="d-paper">Paper size</label>
      <select class="input" id="d-paper">
        ${Object.entries(papers).map(([key, def]) => `<option value="${esc(key)}" ${settings.paper === key ? 'selected' : ''}>${esc(def.label)}${def.mm ? ` · ${def.mm[0]}×${def.mm[1]} mm` : ''}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label>Default copies</label>
      <div class="stepper">
        <button id="d-copies-minus" aria-label="Fewer">${icons.minus}</button>
        <output id="d-copies">${Number(settings.copies) || 1}</output>
        <button id="d-copies-plus" aria-label="More">${icons.plus}</button>
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
    <div class="row wrap" style="gap:12px">
      <div class="field" style="flex:1;min-width:130px">
        <label for="d-upload">Max upload (MB)</label>
        <input class="input" id="d-upload" type="number" min="1" max="200" value="${Number(settings.maxUploadMb) || 25}">
      </div>
      <div class="field" style="flex:1;min-width:130px">
        <label for="d-retention">Keep history (hours)</label>
        <input class="input" id="d-retention" type="number" min="1" max="720" value="${Number(settings.retentionHours) || 48}">
      </div>
      <div class="field" style="flex:1;min-width:130px">
        <label for="d-preview">Preview page limit</label>
        <input class="input" id="d-preview" type="number" min="1" max="200" value="${Number(settings.maxPreviewPages) || 40}">
      </div>
    </div>
    <button class="btn primary" id="d-save">${icons.check}<span>Save defaults</span></button>`;

  const copiesOut = host.querySelector('#d-copies');
  const bump = (delta) => {
    copiesOut.textContent = String(Math.max(1, Math.min(50, (Number(copiesOut.textContent) || 1) + delta)));
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
      <div class="tile"><div class="k small muted">Print path</div><div class="v">${esc(d.activeBackend.id)}</div></div>
      <div class="tile"><div class="k small muted">Silent engine</div><div class="v">${d.tools.silentPrintReady ? 'ready' : 'missing'}</div></div>
      <div class="tile"><div class="k small muted">LibreOffice</div><div class="v">${d.tools.libreoffice ? 'yes' : 'no'}</div></div>
      <div class="tile"><div class="k small muted">Stored jobs</div><div class="v">${d.storage?.jobs ?? 0}</div></div>
    </div>
    <div class="muted small" style="margin:14px 0 8px">Disk usage · ${fmtBytes(d.storage?.totalBytes || 0)}</div>
    <div class="usage-bars">
      ${dirs.map(([name, info]) => `
        <div class="usage-row">
          <div class="row"><span class="muted">${esc(name)}</span><span class="usage-val">${fmtBytes(info.bytes)} · ${info.files} file(s)</span></div>
          <div class="usage-bar"><i style="width:${Math.max(1, Math.round((info.bytes / total) * 100))}%"></i></div>
        </div>`).join('')}
    </div>
    <div class="row wrap" style="margin-top:14px">
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
      toast('Cleanup done', `${res.removed} job file(s) removed`);
      diagnostics = await api.diagnostics();
      paintDiagnostics(container);
    } catch (e) {
      toast('Cleanup failed', e.message, 'err');
    }
  });

  host.querySelector('#s-clear-jobs').addEventListener('click', async () => {
    const finished = store.jobList().filter(j => !['uploading', 'converting', 'queued', 'waiting', 'printing'].includes(j.status));
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
    <div class="log-line l-${esc(entry.level)}">
      <span class="v">${esc(new Date(entry.at).toLocaleTimeString())}</span>
      <span class="k">${esc(entry.scope || '')}</span>
      <span class="m">${esc(entry.message)}</span>
    </div>`).join('');
  if (near) host.scrollTop = host.scrollHeight;
  void fmtAgo;
}
