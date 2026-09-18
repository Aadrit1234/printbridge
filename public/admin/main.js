/* Admin app controller — the door, the routes, and the live status.
 *
 * Nothing renders until the session check says we are signed in; every API call
 * carries the session cookie, and a 401 anywhere drops the UI back to the PIN
 * screen instead of showing half-loaded controls. */

import { api, setUnauthorizedHandler } from './api.js';
import { bootstrap, store, connectEvents, disconnectEvents } from './store.js';
import { applyTheme, currentTheme, toggleTheme } from '../app/theme.js';
import { esc, icons, setThumbUrlBuilder, toast } from '../app/ui.js';

// The shared UI kit renders thumbnails; admin ones come from the admin API.
setThumbUrlBuilder(api.thumbUrl);

import * as queueView from './views/queue.js';
import * as codesView from './views/codes.js';
import * as printerView from './views/printer.js';
import * as settingsView from './views/settings.js';
import * as accessView from './views/access.js';

const viewHost = document.getElementById('view');
const routes = [
  { match: /^#\/queue\/?$/, view: queueView, name: 'queue', title: 'Queue' },
  { match: /^#\/codes\/?$/, view: codesView, name: 'codes', title: 'Print codes' },
  { match: /^#\/printer\/?$/, view: printerView, name: 'printer', title: 'Printer' },
  { match: /^#\/settings\/?$/, view: settingsView, name: 'settings', title: 'Settings' },
  { match: /^#\/access\/?$/, view: accessView, name: 'access', title: 'Access' },
];

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
      <h1>Admin sign-in</h1>
      <p>Enter the PIN to manage the printer, the queue and everyone's jobs.</p>
      <form id="login-form" autocomplete="off">
        <div class="pin-field">
          <input class="input pin-input" id="login-pin" type="password" inputmode="numeric"
                 placeholder="••••••" autocomplete="current-password" aria-label="Admin PIN" required>
        </div>
        <button class="btn primary" id="login-submit" type="submit" style="width:100%">Unlock</button>
      </form>
      <div id="login-error" class="job-error ${message ? '' : 'hidden'}" style="margin-top:12px">${esc(message)}</div>
      <div class="login-foot">
        <div class="login-hint">The PIN is printed in the server console on first run.<br>Lost it? Delete <code>data/access.json</code> and restart.</div>
        <a class="btn sm ghost" href="/">${icons.printer}<span>Print page</span></a>
      </div>
    </div>
  </div>`;
}

function startLockCountdown(input, button, secondsLeft) {
  let left = Number(secondsLeft) || 0;
  const tick = () => {
    if (left <= 0) {
      input.disabled = false;
      button.disabled = false;
      button.textContent = 'Unlock';
      input.focus();
      return;
    }
    input.disabled = true;
    button.disabled = true;
    button.textContent = `Wait ${left}s`;
    left -= 1;
    setTimeout(tick, 1000);
  };
  tick();
}

export function showLogin({ message = '' } = {}) {
  signedIn = false;
  disconnectEvents();
  document.body.classList.add('admin-locked');
  clearLayers();
  const layer = makeLayer();
  layer.innerHTML = loginShell(message);

  const form = layer.querySelector('#login-form');
  const input = layer.querySelector('#login-pin');
  const button = layer.querySelector('#login-submit');
  const error = layer.querySelector('#login-error');
  input.focus();

  // Kiosk keyboards and password managers do not always submit a form by
  // themselves; make Enter explicit.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); form.requestSubmit(); }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const pin = input.value.trim();
    if (!pin) return;
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      await api.login(pin);
      await enterApp();
    } catch (err) {
      error.textContent = err.message || 'Sign-in failed';
      error.classList.remove('hidden');
      input.value = '';
      const retryAfter = err.payload && err.payload.retryAfter;
      if (retryAfter) startLockCountdown(input, button, retryAfter);
      else { input.focus(); button.disabled = false; button.textContent = 'Unlock'; }
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

  const first = viewHost.querySelector('.view-layer');
  if (first && !location.hash) location.hash = '#/queue';
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
  const hash = location.hash || '#/queue';
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

window.addEventListener('hashchange', render);

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

// A dead session anywhere (expired cookie, PIN changed on another device)
// re-arms the door instead of leaving stale controls on screen.
setUnauthorizedHandler(() => {
  if (signedIn) showLogin({ message: 'Your admin session ended — sign in again.' });
});

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (currentTheme() === 'system') applyTheme('system');
});

/* ---------------- boot ---------------- */

applyTheme(currentTheme());

api.session().then((status) => {
  if (status.authenticated) return enterApp();
  return showLogin({ message: status.open ? '' : '' });
}).catch(() => {
  showLogin({ message: 'The print server is not responding. Is it running?' });
});
