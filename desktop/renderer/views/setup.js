/* Setup — the machine, in order.
 *
 * This is the view the app opens on. It is not a wizard you click through once:
 * it reads the real state every time (is the service up, is a printer adopted,
 * is there a code, has a test page ever printed) and tells you the next thing
 * that is actually missing. The six steps are the six things that have to be
 * true for a stranger to walk up and print.
 *
 * Everything desktop-only (restart the service, open the data folder, start
 * with Windows, stay awake, check for updates, run the real suites) lives here
 * too, because this is the machine's own view of itself.
 */

import { api, desktop } from '../api.js';
import { esc, icons, toast } from '../../public/app/ui.js';

let host = null;
let ctxRef = null;
let busy = false;
const results = { selftest: null };

function isDesktop() {
  return Boolean(desktop && desktop.available());
}

/* ---------------------------------------------------------------- markup */

function stepRow({ n, title, state, detail, action }) {
  const mark = state === 'done' ? '✓' : state === 'warn' ? '!' : '○';
  return `
    <li class="setup-step" data-state="${esc(state)}">
      <span class="setup-mark">${mark}</span>
      <div class="setup-body">
        <div class="setup-title"><span class="setup-num">${esc(n)}</span>${esc(title)}</div>
        <p class="setup-detail">${detail}</p>
      </div>
      ${action || ''}
    </li>`;
}

function chip(label, kind = '') {
  return `<span class="chip ${kind ? esc(kind) : ''}">${esc(label)}</span>`;
}

/* ---------------------------------------------------------------- data */

async function collect() {
  const [meta, printer, printers, diagnostics, session] = await Promise.all([
    api.meta().catch(() => null),
    api.printerStatus(true).catch(() => null),
    api.printers().catch(() => ({ printers: [] })),
    api.diagnostics().catch(() => null),
    api.session().catch(() => ({ authenticated: false, protected: true })),
  ]);
  const info = isDesktop() ? await desktop.getInfo().catch(() => null) : null;
  return {
    meta,
    printer,
    codes: printers.printers || [],
    diagnostics,
    session,
    info,
  };
}

/* ---------------------------------------------------------------- render */

export async function render(viewHost, params, ctx) {
  host = viewHost;
  ctxRef = ctx;
  await paint();
  await wireDesktop();
  return {
    update(type) {
      if (['printer', 'job', 'connection', 'boot', 'settings'].includes(type)) scheduleRepaint();
    },
    destroy() {
      if (repaintTimer) clearTimeout(repaintTimer);
      repaintTimer = null;
      host = null;
    },
  };
}

let repaintTimer = null;
function scheduleRepaint() {
  if (!host || repaintTimer) return;
  repaintTimer = setTimeout(() => {
    repaintTimer = null;
    paint().catch(() => {});
  }, 700);
}

async function paint() {
  if (!host) return;
  const { meta, printer, codes, diagnostics, session, info } = await collect();
  if (!host) return;

  const pState = printer && printer.state ? printer.state : {};
  const status = String(pState.status || 'unknown');
  const printerReady = ['ready', 'busy', 'printing'].includes(status);
  const outboxOnly = printer && printer.active && printer.active.id === 'outbox';
  const engineReady = Boolean(diagnostics && diagnostics.tools && diagnostics.tools.silentPrintReady);
  const hasCode = codes.length > 0;

  const guestOrigin = meta && meta.addresses && meta.addresses.length
    ? meta.addresses[0]
    : (meta && meta.lanUrl) || location.origin;
  const guestLink = `${guestOrigin}/print`;

  host.innerHTML = `
    <header class="section-head">
      <div>
        <h1>Setup</h1>
        <p class="lead">Six things have to be true before a stranger can walk up and print. This page
        reads them off the running service — it is never a rehearsal.</p>
      </div>
      <div class="row">
        <button class="btn sm ghost" id="setup-refresh">${icons.refresh}<span>Refresh</span></button>
      </div>
    </header>

    <ol class="setup-list">
      ${stepRow({
        n: '01',
        title: 'The service is running on this machine',
        state: meta ? 'done' : 'warn',
        detail: meta
          ? `PrintBridge ${esc(meta.version)} · node ${esc(meta.node)} · ${esc(meta.platform)} ${esc(meta.arch)} · host ${esc(meta.hostname)}`
          : 'No answer from the print service. Restart it from the panel below.',
        action: isDesktop() ? '<button class="btn sm ghost" data-act="restart">Restart</button>' : '',
      })}

      ${stepRow({
        n: '02',
        title: 'A printer is adopted',
        state: printerReady ? 'done' : outboxOnly ? 'warn' : 'todo',
        detail: printer
          ? `${esc(printer.active.label)} · ${esc(status)} — ${esc(pState.detail || printer.reason || '')}`
          : 'The printer state cannot be read yet.',
        action: `<button class="btn sm ghost" data-go="#/printer">Printer</button>`,
      })}

      ${stepRow({
        n: '03',
        title: 'A silent print engine is present',
        state: engineReady ? 'done' : 'todo',
        detail: engineReady
          ? 'A PDF can reach the Windows queue with nobody sitting at the machine.'
          : 'Nothing can print a PDF unattended yet. Install the engine on the Printer page.',
        action: engineReady ? '' : '<button class="btn sm ghost" data-go="#/printer">Install</button>',
      })}

      ${stepRow({
        n: '04',
        title: 'A walk-up code exists',
        state: hasCode ? 'done' : 'todo',
        detail: hasCode
          ? `${codes.length} code${codes.length === 1 ? '' : 's'} — ${codes.slice(0, 3).map(c => esc(c.code)).join(' · ')}${codes.length > 3 ? ' …' : ''}`
          : 'Nobody can send a document yet: a code is what a guest types or scans.',
        action: `<button class="btn sm ghost" data-go="#/printers">Printers</button>`,
      })}

      ${stepRow({
        n: '05',
        title: 'The guest page is reachable',
        state: meta ? 'done' : 'todo',
        detail: `Guests on this network open <code>${esc(guestLink)}</code> — no app, no account.`,
        action: `<a class="btn sm ghost" href="${esc(guestLink)}" target="_blank" rel="noopener">Open</a>`,
      })}

      ${stepRow({
        n: '06',
        title: 'The console is locked',
        state: session && session.protected ? 'done' : 'warn',
        detail: session && session.protected
          ? 'Signed in with the machine PIN.'
          : 'No PIN is set — anyone who reaches this machine could change everything.',
        action: `<button class="btn sm ghost" data-go="#/access">Access</button>`,
      })}
    </ol>

    <div class="split">
      <section class="card">
        <div class="card-head">
          <h2>${icons.printer}<span>Prove it, for real</span></h2>
          <span class="card-sub">through the same pipeline a guest's document takes</span>
        </div>
        <div class="row">
          <button class="btn primary" id="setup-test">Print a test page</button>
          <button class="btn ghost" id="setup-card">Print the QR card</button>
          ${isDesktop() ? '<button class="btn ghost" id="setup-selftest">Run the end-to-end suites</button>' : ''}
        </div>
        <p class="small muted" id="setup-test-note">A test page becomes a normal job, so it shows up in the queue and can be followed to the tray.</p>
        <pre class="log" id="setup-selftest-out" ${results.selftest ? '' : 'hidden'}>${results.selftest ? esc(results.selftest) : ''}</pre>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>${icons.alert}<span>This machine</span></h2>
          <span class="card-sub">${isDesktop() ? 'desktop app' : 'browser'}</span>
        </div>
        <dl class="facts">
          <div><dt>Data directory</dt><dd><code>${esc((info && info.dataDir) || (diagnostics && diagnostics.outbox) || '—')}</code></dd></div>
          <div><dt>To guests</dt><dd>${esc(guestOrigin)}</dd></div>
          <div><dt>To this network</dt><dd>${esc((meta && meta.addresses || []).join(' · ') || '—')}</dd></div>
          <div><dt>Uptime</dt><dd>${esc(diagnostics && diagnostics.uptimeSeconds !== undefined ? `${Math.round(diagnostics.uptimeSeconds / 60)} min` : '—')}</dd></div>
          <div><dt>Updates</dt><dd id="setup-update">${isDesktop() ? 'checking…' : 'desktop app only'}</dd></div>
        </dl>
        ${isDesktop() ? `
        <label class="check"><input type="checkbox" id="setup-autostart"><span>Start PrintBridge when I sign in to Windows</span></label>
        <label class="check"><input type="checkbox" id="setup-awake"><span>Keep this machine awake while printing</span></label>
        <div class="row">
          <button class="btn sm ghost" id="setup-open-data">Open data folder</button>
          <button class="btn sm ghost" id="setup-check-update">Check for updates</button>
        </div>` : `<p class="small muted">Restarting the service, autostart, staying awake and updates are desktop-app controls.</p>`}
      </section>
    </div>

    <section class="card">
      <div class="card-head">
        <h2>${icons.shield}<span>Let phones reach this machine</span></h2>
        <span class="card-sub">once, in an administrator PowerShell</span>
      </div>
      <p class="small">Windows blocks incoming connections by default. This is the rule that opens the
      guest page and nothing else:</p>
      <div class="copyrow">
        <code id="setup-firewall">New-NetFirewallRule -DisplayName "PrintBridge" -Direction Inbound -Action Allow \`
  -Protocol TCP -LocalPort ${esc(String((meta && String(meta.lanUrl || '').match(/:(\d+)/)) ? String(meta.lanUrl).match(/:(\d+)/)[1] : '8088'))} -Profile Private</code>
        <button class="btn sm ghost" id="setup-copy-firewall">${icons.copy}<span>Copy</span></button>
      </div>
      <p class="small muted">Then give this machine a DHCP reservation in the router, so the address on every
      printed sticker keeps working.</p>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>${icons.queue}<span>Service log</span></h2>
        <button class="btn sm ghost" id="setup-log-refresh">Refresh</button>
      </div>
      <pre class="log" id="setup-log">loading…</pre>
    </section>
  `;

  wire();
  paintStatusBar({ meta, printer, status, info });
}

function paintStatusBar({ meta, printer, status, info }) {
  const bar = document.getElementById('desktop-statusbar');
  if (!bar) return;
  const set = (id, text, cls) => {
    const el = bar.querySelector(id);
    if (el) { el.textContent = text; if (cls !== undefined) el.dataset.state = cls; }
  };
  set('#sb-service', meta ? `service ${meta.version} · port ${(String(meta.lanUrl || '').match(/:(\d+)/) || [])[1] || '—'}` : 'service down', meta ? 'ok' : 'bad');
  set('#sb-printer', printer ? `${(printer.active && printer.active.label) || 'printer'} · ${status}` : 'printer: —', ['ready', 'busy', 'printing'].includes(status) ? 'ok' : 'warn');
  set('#sb-mode', info ? (info.packaged ? 'packaged' : 'development') : 'hosted');
}

/* ---------------------------------------------------------------- wiring */

function wire() {
  const go = (hash) => { if (ctxRef && ctxRef.navigate) ctxRef.navigate(hash); else location.hash = hash; };

  host.querySelectorAll('[data-go]').forEach((button) => {
    button.addEventListener('click', () => go(button.dataset.go));
  });

  host.querySelector('#setup-refresh')?.addEventListener('click', () => paint().then(() => toast('Re-read the machine')));

  host.querySelector('[data-act="restart"]')?.addEventListener('click', async () => {
    if (!isDesktop()) return toast('Restart lives in the desktop app', '', 'err');
    await desktop.restartServer();
    toast('Restarting the print service…');
    setTimeout(() => paint().catch(() => {}), 2200);
  });

  host.querySelector('#setup-printers-link')?.addEventListener('click', () => go('#/printers'));

  host.querySelector('#setup-test')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await api.printerTest();
      const job = result.job || {};
      const note = host.querySelector('#setup-test-note');
      if (note) note.textContent = `Sent — job ${String(job.id || '').slice(0, 8)} is ${job.status || 'queued'}. It retries on its own if the printer is asleep.`;
      toast('Test page sent', 'the printer should be busy', 'ok');
    } catch (error) {
      toast('Could not print the test page', error.message, 'err');
    } finally {
      button.disabled = false;
    }
  });

  host.querySelector('#setup-card')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await api.printQrCard();
      toast('QR card sent to the printer', '', 'ok');
    } catch (error) {
      toast('Could not print the card', error.message, 'err');
    } finally {
      if (event.currentTarget) event.currentTarget.disabled = false;
    }
  });

  host.querySelector('#setup-selftest')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const out = host.querySelector('#setup-selftest-out');
    button.disabled = true;
    button.textContent = 'Running…';
    if (out) { out.hidden = false; out.textContent = 'starting the suites…\n'; }
    try {
      const report = await desktop.runSelfTest();
      const text = (report.lines || []).join('\n');
      results.selftest = text;
      if (out) out.textContent = text;
      toast(report.ok ? 'Self-test passed' : 'Self-test finished with failures', report.ok ? 'every suite agreed' : 'open the log above', report.ok ? 'ok' : 'err', 8000);
    } catch (error) {
      if (out) out.textContent = `could not run the suites: ${error.message}`;
      toast('Self-test failed to start', error.message, 'err');
    } finally {
      button.disabled = false;
      button.textContent = 'Run the end-to-end suites';
    }
  });

  host.querySelector('#setup-log-refresh')?.addEventListener('click', refreshLog);
  refreshLog();
}

function refreshLog() {
  const box = host && host.querySelector('#setup-log');
  if (!box) return;
  const write = (text) => { if (box) { box.textContent = text || '(nothing yet)'; box.scrollTop = box.scrollHeight; } };
  api.logs(160).then((payload) => {
    const rows = (payload.logs || []).map((entry) => `${entry.time ? String(entry.time).slice(11, 19) + ' ' : ''}[${entry.level || 'info'}] ${entry.message || entry.msg || ''}`);
    write(rows.join('\n'));
  }).catch((error) => write(`could not read the log: ${error.message}`));
}

/** The desktop-only controls, wired once the bridge is known to exist. */
async function wireDesktop() {
  const bar = document.getElementById('desktop-statusbar');
  if (bar) bar.hidden = false;
  if (!isDesktop()) return;

  const autostart = host.querySelector('#setup-autostart');
  const awake = host.querySelector('#setup-awake');
  const updateCell = host.querySelector('#setup-update');

  desktop.autostart.get().then(({ supported, enabled }) => {
    if (!autostart) return;
    if (!supported) { autostart.closest('label').hidden = true; return; }
    autostart.checked = Boolean(enabled);
    autostart.addEventListener('change', async () => {
      try {
        await desktop.autostart.set(autostart.checked);
        toast(autostart.checked ? 'PrintBridge will start with Windows' : 'Autostart off', '', 'ok');
      } catch (error) { autostart.checked = !autostart.checked; toast('Could not change autostart', error.message, 'err'); }
    });
  }).catch(() => { if (autostart) autostart.closest('label').hidden = true; });

  desktop.keepAwake.get().then(({ enabled }) => {
    if (!awake) return;
    awake.checked = Boolean(enabled);
    awake.addEventListener('change', async () => {
      try { await desktop.keepAwake.set(awake.checked); } catch (error) { toast('Could not change that', error.message, 'err'); }
    });
  }).catch(() => {});

  const showUpdate = (state) => {
    if (!updateCell) return;
    const map = {
      checking: 'checking…',
      current: 'up to date',
      available: `v${state && state.version ? state.version : '?'} available`,
      downloading: 'downloading…',
      ready: 'ready — restart to install',
      error: 'could not check',
      off: 'not in this build',
    };
    updateCell.textContent = map[state && state.kind] || '—';
  };

  if (desktop.updates) {
    desktop.updates.status().then(showUpdate).catch(() => {});
    desktop.updates.subscribe(showUpdate);
    host.querySelector('#setup-check-update')?.addEventListener('click', async () => {
      showUpdate({ kind: 'checking' });
      const result = await desktop.updates.check().catch((error) => ({ kind: 'error', message: error.message }));
      showUpdate(result || { kind: 'error' });
      if (result && result.kind === 'current') toast('PrintBridge is up to date');
      if (result && result.kind === 'available') toast(`Version ${result.version} is available`, 'downloading it now', 'ok');
      if (result && result.kind === 'error') toast('Could not check for updates', result.message || '', 'err');
    });
  }
}
