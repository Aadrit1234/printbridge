/* Admin app controller — the door, the routes, and the live status.
 *
 * Nothing renders until the session check says we are signed in; every API call
 * carries the session cookie, and a 401 anywhere drops the UI back to the
 * sign-in screen instead of showing half-loaded controls. */

import { api, setUnauthorizedHandler, desktop } from './api.js';
import { bootstrap, store, connectEvents, disconnectEvents } from './store.js';
import { applyTheme, currentTheme, toggleTheme } from '../app/theme.js';
import { esc, icons, setThumbUrlBuilder, toast } from '../app/ui.js';

// The shared UI kit renders thumbnails; admin ones come from the admin API.
setThumbUrlBuilder(api.thumbUrl);

import * as setupView from './views/setup.js';
import * as queueView from './views/queue.js';
import * as codesView from './views/codes.js';
import * as printersView from './views/printers.js';
import * as printerView from './views/printer.js';
import * as settingsView from './views/settings.js';
import * as accessView from './views/access.js';
import * as accountView from './views/account.js';
import * as connectionView from './views/connection.js';
import * as pricingView from './views/pricing.js';
import * as expensesView from './views/expenses.js';
import * as reportsView from './views/reports.js';
import { availableOffline as shopAvailableOffline } from './shop.js';

const viewHost = document.getElementById('view');

/* Every panel this console can show. Which ones it *does* show is the app's
 * profile (desktop/shared/profile.js): the machine's app has Setup and no
 * pricing; the shop's app has pricing, expenses and revenue and points at a
 * machine; each hides what it does not have rather than showing it disabled. */
const ROUTES = [
  { match: /^#\/connection\/?$/, view: connectionView, name: 'connection', title: 'Machines' },
  { match: /^#\/setup\/?$/, view: setupView, name: 'setup', title: 'Setup' },
  { match: /^#\/queue\/?$/, view: queueView, name: 'queue', title: 'Queue' },
  { match: /^#\/codes\/?$/, view: codesView, name: 'codes', title: 'Print codes' },
  { match: /^#\/printers\/?$/, view: printersView, name: 'printers', title: 'Printers' },
  { match: /^#\/printer\/?$/, view: printerView, name: 'printer', title: 'Printer' },
  { match: /^#\/pricing\/?$/, view: pricingView, name: 'pricing', title: 'Pricing' },
  { match: /^#\/expenses\/?$/, view: expensesView, name: 'expenses', title: 'Expenses' },
  { match: /^#\/reports\/?$/, view: reportsView, name: 'reports', title: 'Revenue & reports' },
  { match: /^#\/settings\/?$/, view: settingsView, name: 'settings', title: 'Settings' },
  { match: /^#\/access\/?$/, view: accessView, name: 'access', title: 'Access' },
  { match: /^#\/account\/?$/, view: accountView, name: 'account', title: 'Account' },
];

/* What this app is, from the main process. Set before anything renders. */
let shell = { panels: null, home: '#/setup', productName: 'PrintBridge', supervises: true, machine: null };
let routes = ROUTES;

/* Sidebar entries for panels that have no markup of their own yet. The panels
 * that came from the old web console keep their icons in index.html; the four
 * the shop's app adds are drawn here. */
const NAV_EXTRA = {
  connection: {
    label: 'Machines',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="10" rx="2"/><path d="M8 19h8"/><path d="M12 15v4"/></svg>',
  },
  pricing: {
    label: 'Pricing',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 12 22l-9-9V4h9l8.6 8.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.2"/></svg>',
  },
  expenses: {
    label: 'Expenses',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2Z"/><path d="M9 8h6"/><path d="M9 12h6"/></svg>',
  },
  reports: {
    label: 'Revenue',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16V9"/><path d="M13 16v-4"/><path d="M18 16V7"/></svg>',
  },
};

/** Take on what this app is: its panels, where it opens, what it calls itself. */
function applyProfile(info) {
  if (!info || !info.profile) return;
  shell = { ...shell, ...info.profile, machine: info.machine || null };
  const wanted = new Set(shell.panels || []);
  routes = ROUTES.filter(route => wanted.has(route.name));
  if (!routes.length) routes = ROUTES.filter(route => route.name === 'queue');

  const brand = document.getElementById('brand-name');
  const sub = document.getElementById('brand-sub');
  if (brand) brand.textContent = shell.productName.replace(/^PrintBridge\s+/, '');
  if (sub) sub.textContent = shell.tagline || shell.productName;

  const appLine = document.getElementById('sidebar-app');
  if (appLine) {
    appLine.textContent = shell.machine
      ? `${shell.machine.name} · ${shell.machine.id}`
      : (shell.picksMachine ? 'no machine chosen' : shell.productName);
  }

  buildNav(wanted);
}

/** Show only the panels this app has; add the ones index.html has no markup for. */
function buildNav(wanted) {
  const nav = document.getElementById('sidebar-nav');
  const bottom = document.getElementById('bottomnav');
  const present = new Set();
  for (const link of document.querySelectorAll('[data-route]')) {
    present.add(link.dataset.route);
    if (!wanted.has(link.dataset.route)) link.remove();
  }
  for (const name of wanted) {
    const meta = NAV_EXTRA[name];
    if (!meta || present.has(name)) continue;
    const item = `<a class="nav-item" href="#/${name}" data-route="${name}">${meta.svg}<span>${meta.label}</span></a>`;
    if (nav) {
      /* Choosing a machine is the first thing the shop's app does, so it goes
       * at the top; everything else follows on from what is already there. */
      if (name === 'connection') nav.insertAdjacentHTML('afterbegin', item);
      else nav.insertAdjacentHTML('beforeend', item);
    }
    if (bottom) bottom.insertAdjacentHTML('beforeend', `<a href="#/${name}" data-route="${name}">${meta.svg}<span>${meta.label}</span></a>`);
  }
}

/* Where the app opens: wherever you were last, if that panel exists here, then
 * the profile's own first panel — Setup on a fresh install, Machines for a shop. */
function startRoute() {
  try {
    const saved = localStorage.getItem('pb.desktop.route');
    if (saved && routes.some(r => `#/${r.name}` === saved)) return saved;
  } catch { /* private mode */ }
  return shell.home || '#/setup';
}

let current = null;
let signedIn = false;

/* ---------------- layers ---------------- */

function clearLayers() {
  if (current && current.destroy) {
    try { current.destroy(); } catch { /* noop */ }
  }
  current = null;
  viewHost.innerHTML = '';
}

function makeLayer() {
  for (const stale of Array.from(viewHost.children)) stale.remove();
  const layer = document.createElement('div');
  layer.className = 'view-layer';
  viewHost.appendChild(layer);
  return layer;
}

/* ---------------- sign in ---------------- */

function loginShell(message) {
  return `
  <div class="login-wrap">
    <div class="card login-card">
      <div class="login-mark">${icons.shield}</div>
      <h1>Sign in</h1>
      <p>The console runs here, in the app, and nowhere else on the network. Sign in with this machine's
      username and password — or with the email and password of the owner account that holds the licence.</p>
      <form id="login-form" autocomplete="on">
        <div class="field">
          <label class="opt-label" for="login-user">Username</label>
          <input class="input" id="login-user" name="username" type="text"
                 autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false"
                 placeholder="admin" required>
        </div>
        <div class="field" style="margin-top:10px">
          <label class="opt-label" for="login-pass">Password</label>
          <input class="input" id="login-pass" name="password" type="password" autocomplete="current-password" required>
        </div>
        <button class="btn primary" id="login-submit" type="submit" style="width:100%;margin-top:14px">Sign in</button>
      </form>
      <div id="login-error" class="job-error ${message ? '' : 'hidden'}" style="margin-top:12px">${esc(message)}</div>
      ${shell.picksMachine && shell.machine ? `
      <div class="login-machine">
        <span class="muted small">Working with <strong>${esc(shell.machine.name || shell.machine.id)}</strong>
        <code>${esc(shell.machine.host)}:${esc(String(shell.machine.port))}</code></span>
        <button class="btn sm ghost" id="login-machine" type="button">Choose a different machine</button>
      </div>` : ''}
      <div class="login-foot">
        <div class="login-hint">The sign-in is printed in the server console on first run.<br>Lost it? Delete <code>data/access.json</code> and restart.</div>
        <a class="btn sm ghost" href="/print/">${icons.printer}<span>Print page</span></a>
      </div>
    </div>
  </div>`;
}

function startLockCountdown(inputs, button, secondsLeft) {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  let left = Number(secondsLeft) || 0;
  const tick = () => {
    if (left <= 0) {
      for (const input of list) input.disabled = false;
      button.disabled = false;
      button.textContent = 'Sign in';
      (list[0] || {}).focus?.();
      return;
    }
    for (const input of list) input.disabled = true;
    button.disabled = true;
    button.textContent = `Wait ${left}s`;
    left -= 1;
    setTimeout(tick, 1000);
  };
  tick();
}

/**
 * The first screen for an app that manages somebody else's machine.
 *
 * The shop's app and the customer's app do not *have* a server until one is
 * chosen, so the session call has nothing to answer it — which is why a fresh
 * install used to open on a sign-in form saying "the print server is not
 * responding. Is it running?". It was, elsewhere; this app just had not been
 * told where. The machine picker is the honest first screen: choose one, the
 * page reloads pointed at it, and the sign-in that follows is a real one.
 */
export async function showMachinePicker({ unresponsive = false } = {}) {
  signedIn = false;
  disconnectEvents();
  document.body.classList.add('admin-locked');
  clearLayers();
  const layer = makeLayer();
  const heading = document.createElement('p');
  heading.className = 'muted small';
  heading.style.margin = '0 0 14px';
  heading.textContent = unresponsive
    ? `The machine this console was pointed at${shell.machine ? ` (${shell.machine.name})` : ''} did not answer — it may be switched off. Choose the machine to work with, or wake that one up.`
    : 'Step 1 of 2 — choose the printer machine this console manages. Signing in comes next.';
  layer.appendChild(heading);
  try {
    await connectionView.render(layer);
  } catch (error) {
    layer.innerHTML = `<div class="card"><h1>Find your machine</h1>
      <p class="lead">${esc(shell.offlineHint || 'Choose the printer machine this app manages.')}</p>
      <p class="muted small">The picker could not open: ${esc(error.message)}</p></div>`;
  }
}

export function showLogin({ message = '' } = {}) {
  signedIn = false;
  disconnectEvents();
  document.body.classList.add('admin-locked');
  clearLayers();
  const layer = makeLayer();
  layer.innerHTML = loginShell(message);

  const form = layer.querySelector('#login-form');
  const user = layer.querySelector('#login-user');
  const pass = layer.querySelector('#login-pass');
  const button = layer.querySelector('#login-submit');
  const error = layer.querySelector('#login-error');
  user.focus();

  /* A console app can be pointed at the wrong machine — the shop moved it, the
   * address changed, somebody typed it in — and then the sign-in here can never
   * succeed. Without this the only way out was deleting machines.json by hand,
   * because the menus that reach the picker sit behind being signed in. */
  layer.querySelector('#login-machine')?.addEventListener('click', () => showMachinePicker());

  // A browser's autofill and a kiosk keyboard do not always submit a form by
  // themselves; make Enter explicit.
  for (const field of [user, pass]) {
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); form.requestSubmit(); }
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = user.value.trim();
    const password = pass.value;
    if (!username || !password) return;
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      await api.login(username, password);
      /* Held in memory by the app so the end-to-end suites can sign in too —
       * they send it as the password, with no username. */
      desktop.rememberPassword(password).catch(() => {});
      await enterApp();
    } catch (err) {
      error.textContent = err.message || 'Sign-in failed';
      error.classList.remove('hidden');
      pass.value = '';
      const retryAfter = err.payload && err.payload.retryAfter;
      if (retryAfter) startLockCountdown([user, pass], button, retryAfter);
      else { pass.focus(); button.disabled = false; button.textContent = 'Sign in'; }
    }
  });
}

/* ---------------- signed in ---------------- */

async function enterApp() {
  signedIn = true;
  document.body.classList.remove('admin-locked');
  clearLayers();

  if (!store.state.ready) {
    try {
      await bootstrap();
    } catch (e) {
      if (e.status === 401) { showLogin({ message: 'That session expired — sign in again.' }); return; }
      toast('Cannot reach the server', e.message, 'err', 7000);
    }
  } else {
    connectEvents();
  }

  if (!location.hash) location.hash = startRoute();
  await render();
  paintStatus();
  paintBadges();
}

function signOut(reason = '') {
  api.logout().catch(() => { /* signing out locally is enough */ });
  showLogin({ message: reason });
}

/* ---------------- routing ---------------- */

function resolveRoute() {
  const hash = location.hash || '#/setup';
  for (const route of routes) {
    const m = hash.match(route.match);
    if (m) return { route, params: {} };
  }
  return { route: routes[0], params: {} };
}

function syncNav(name) {
  for (const link of document.querySelectorAll('[data-route]')) {
    link.classList.toggle('active', link.dataset.route === name);
  }
  const title = document.getElementById('topbar-title');
  const resolved = routes.find(r => r.name === name);
  if (title && resolved) title.textContent = resolved.title;
}

async function render() {
  if (!signedIn) return;
  const { route, params } = resolveRoute();

  if (current && current.destroy) {
    try { current.destroy(); } catch (e) { console.error('view teardown failed', e); }
  }
  current = null;
  syncNav(route.name);

  // Same layered scheme as the guest app: a view that is still loading keeps its
  // own subtree, so navigating away mid-load cannot crash it.
  for (const stale of Array.from(viewHost.children)) stale.hidden = true;
  const layer = document.createElement('div');
  layer.className = 'view-layer';
  viewHost.appendChild(layer);

  const handle = await route.view.render(layer, params, { navigate });
  for (const stale of Array.from(viewHost.children)) {
    if (stale !== layer) stale.remove();
  }

  current = { name: route.name, handle, params };
  if (handle && handle.update) handle.update('mount');
}

export async function navigate(hash, { replace = false } = {}) {
  if (replace) location.replace(hash);
  else location.hash = hash;
}

window.addEventListener('hashchange', () => {
  try { localStorage.setItem('pb.desktop.route', location.hash); } catch { /* private mode */ }
  render();
});

/* ---------------- live status ---------------- */

function paintStatus() {
  const printer = store.state.printer;
  const connection = store.state.connection;
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const side = document.getElementById('sidebar-printer');

  const status = printer && printer.state ? printer.state.status : 'unknown';
  if (dot) dot.className = `dot ${connection === 'live' ? status : 'offline'}`;

  let label;
  if (connection !== 'live') label = connection === 'offline' ? 'server offline' : 'connecting…';
  else if (!printer) label = 'checking printer…';
  else if (status === 'ready') label = printer.state.name || 'printer ready';
  else if (status === 'busy') label = `${printer.state.name || 'printer'} · busy`;
  else if (status === 'unconfigured') label = 'printer not selected';
  else if (status === 'error' || status === 'offline') label = 'printer problem';
  else label = status;

  if (text) text.textContent = label;
  if (side) {
    side.textContent = printer
      ? `printer: ${printer.state.name || printer.active.id} · ${status}`
      : 'printer: connecting…';
  }

  const sbPrinter = document.getElementById('sb-printer');
  if (sbPrinter) {
    sbPrinter.textContent = printer
      ? `${printer.active.label} · ${status}`
      : 'printer: not read yet';
    sbPrinter.dataset.state = ['ready', 'busy', 'printing'].includes(status) ? 'ok' : 'warn';
  }
}

/* ---------------- the machine strip ---------------- */

async function wireStatusBar() {
  const bar = document.getElementById('desktop-statusbar');
  if (!bar) return;
  bar.hidden = false;

  const info = await desktop.getInfo().catch(() => null);
  const mode = document.getElementById('sb-mode');
  if (mode) mode.textContent = info ? `${info.packaged ? 'app' : 'dev'} ${info.version}` : 'browser';

  const service = document.getElementById('sb-service');
  const update = document.getElementById('sb-update');

  const restart = document.getElementById('sb-restart');
  const openData = document.getElementById('sb-data');
  if (!desktop.available()) {
    if (restart) restart.hidden = true;
    if (openData) openData.hidden = true;
    if (update) update.hidden = true;
    return;
  }

  /* Restarting a service is only a thing you can do where it runs. The shop's
   * app reads somebody else's machine; it must not offer to restart it. */
  if (info && info.profile && !info.profile.supervises && restart) restart.hidden = true;

  restart?.addEventListener('click', async () => {
    restart.disabled = true;
    restart.textContent = 'Restarting…';
    await desktop.restartServer().catch((error) => toast('Restart failed', error.message, 'err'));
    toast('The print service is restarting', '', 'info');
    setTimeout(() => {
      restart.disabled = false;
      restart.textContent = 'Restart service';
      window.location.reload();
    }, 2600);
  });

  openData?.addEventListener('click', () => {
    desktop.openDataFolder().catch((error) => toast('Could not open the folder', error.message, 'err'));
  });

  const paintUpdate = (state) => {
    if (!update) return;
    const labels = {
      checking: 'checking for updates…',
      current: 'up to date',
      available: 'update available',
      downloading: 'downloading update…',
      ready: 'restart to update',
      error: 'update check failed',
      off: 'updates off',
    };
    update.textContent = labels[state && state.kind] || 'updates';
    update.dataset.state = (state && state.kind) === 'current' ? 'ok' : (state && state.kind) === 'error' ? 'bad' : 'warn';
  };

  if (desktop.updates) {
    desktop.updates.status().then(paintUpdate).catch(() => {});
    desktop.updates.subscribe(paintUpdate);
    update?.addEventListener('click', () => {
      paintUpdate({ kind: 'checking' });
      desktop.updates.check().catch((error) => paintUpdate({ kind: 'error', message: error.message }));
    });
    update.title = 'Check for a new version';
  } else if (update) {
    paintUpdate({ kind: 'off' });
  }

  // The service's own state, straight from the app, not the browser's idea of it.
  if (service) {
    if (shell.supervises) {
      service.textContent = `service · port ${info ? info.port : '?'}${info && info.startedByUs ? '' : ' (external)'}`;
      service.dataset.state = 'ok';
    } else {
      /* No service of our own to report: say which machine we are reading. */
      service.textContent = shell.machine ? `machine · ${shell.machine.name}` : 'machine · none chosen';
      service.dataset.state = shell.machine ? 'ok' : 'warn';
    }
  }
}

function paintBadges() {
  const active = store.activeJobs().length;
  const failed = store.jobList().filter(j => j.status === 'failed').length;

  const queue = document.getElementById('nav-badge-queue');
  if (queue) {
    queue.hidden = !(active || failed);
    queue.classList.toggle('hot', Boolean(active));
    queue.classList.toggle('fail', !active && Boolean(failed));
    if (active) queue.textContent = String(active);
    else if (failed) queue.innerHTML = `${icons.alert}<span>${failed}</span>`;
    else queue.textContent = '';
  }

  // Live print commands: the count is the number of codes still moving.
  const moving = store.jobList().filter(j => ['queued', 'waiting', 'printing'].includes(j.status)).length;
  const codes = document.getElementById('nav-badge-codes');
  if (codes) {
    codes.hidden = !moving;
    codes.classList.toggle('hot', Boolean(moving));
    codes.textContent = moving ? String(moving) : '';
  }
}

store.subscribe((type) => {
  if (['printer', 'connection', 'hello', 'boot', 'resync'].includes(type)) paintStatus();
  if (['job', 'jobDeleted', 'hello', 'boot', 'resync'].includes(type)) paintBadges();
  if (current && current.handle) {
    try { current.handle.update(type, current.params); } catch (e) { console.error('view update failed', e); }
  }
});

/* ---------------- shell wiring ---------------- */

function handleThemeToggle() {
  const next = toggleTheme();
  toast(`Switched to ${next} theme`, '', 'info', 2000);
  store.emit('theme');
}

document.getElementById('btn-theme')?.addEventListener('click', handleThemeToggle);
document.getElementById('btn-logout')?.addEventListener('click', () => signOut('Signed out.'));
document.getElementById('btn-logout-mobile')?.addEventListener('click', () => signOut('Signed out.'));

// A dead session anywhere (expired cookie, sign-in changed on another device)
// re-arms the door instead of leaving stale controls on screen.
setUnauthorizedHandler(() => {
  if (signedIn) showLogin({ message: 'Your session ended — sign in again.' });
});

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (currentTheme() === 'system') applyTheme('system');
});

/* ---------------- boot ---------------- */

applyTheme(currentTheme());

/* What this app is, before anything is drawn: the panels change with the
 * profile, and a panel that flashes up and then disappears is worse than a
 * blank half-second. */
applyProfile(await desktop.getInfo().catch(() => null));
wireStatusBar();

// Panels ▸ … in the menu bar and the tray icons land here.
desktop.onNavigate((hash) => {
  if (!hash) return;
  if (location.hash === hash) render();
  else location.hash = hash;
});

/* Which screen comes first is the app's business, not the server's. An app that
 * picks a machine has to pick it before there is a server to ask anything of. */
if (shell.picksMachine && !shell.machine) {
  showMachinePicker();
} else {
  api.session().then((status) => {
    if (status.authenticated) return enterApp();
    return showLogin({ message: status.open ? '' : '' });
  }).catch(async () => {
    /* The machine did not answer. A shop's books are on this computer, so
     * dropping to the machine picker would lock the owner out of the one part
     * of this app that does not need the machine at all. */
    if (shell.picksMachine && await shopAvailableOffline().catch(() => false)) {
      toast('Working offline', 'The machine is not answering — these are the books saved on this computer. Changes wait and sync when it is back.', 'info', 9000);
      return enterApp();
    }
    if (shell.picksMachine) return showMachinePicker({ unresponsive: true });
    return showLogin({ message: 'The print server is not responding. Is it running?' });
  });
}
