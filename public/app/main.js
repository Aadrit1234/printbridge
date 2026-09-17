/* App controller — routing, theme, live status, PWA. */

import { api, adminUrl } from './api.js';
import { bootstrap, store } from './store.js';
import { applyTheme, currentTheme, systemTheme, toggleTheme } from './theme.js';
import { esc, icons, setThumbUrlBuilder, toast } from './ui.js';

// Thumbnails need the device id, which only this client knows how to attach.
setThumbUrlBuilder(api.thumbUrl);

/* Point every "Admin" link at wherever the admin console actually lives: this
 * origin when the backend serves the app, the backend's URL when this frontend
 * is deployed to a static host. */
for (const link of document.querySelectorAll('[data-admin-link]')) link.href = adminUrl();

import * as printView from './views/print.js';
import * as previewView from './views/preview.js';
import * as mineView from './views/mine.js';

/* The guest app has exactly three screens. Printer setup, defaults, storage,
 * diagnostics and everybody else's jobs live in the admin app at /admin —
 * a phone that scanned the QR code never downloads or reaches them. */
const routes = [
  { match: /^#\/print\/?$/, view: printView, name: 'print', title: 'Print' },
  { match: /^#\/preview\/([\w-]+)$/, view: previewView, name: 'preview', title: 'Preview', params: (m) => ({ id: m[1] }) },
  { match: /^#\/mine\/?$/, view: mineView, name: 'mine', title: 'My prints' },
];

const viewHost = document.getElementById('view');
let current = null;

function resolveRoute() {
  const hash = location.hash || '#/print';
  for (const route of routes) {
    const m = hash.match(route.match);
    if (m) return { route, params: route.params ? route.params(m) : {} };
  }
  return { route: routes[0], params: {} };
}

function syncNav(name) {
  const activeName = name === 'preview' ? 'print' : name;
  for (const link of document.querySelectorAll('[data-route]')) {
    link.classList.toggle('active', link.dataset.route === activeName);
  }
  const title = document.getElementById('topbar-title');
  const resolved = routes.find(r => r.name === name);
  if (title && resolved) title.textContent = resolved.title;
}

export async function navigate(hash, { replace = false } = {}) {
  if (replace) location.replace(hash);
  else location.hash = hash;
}

async function render() {
  const { route, params } = resolveRoute();

  if (current && current.destroy) {
    try { current.destroy(); } catch (e) { console.error('view teardown failed', e); }
  }
  current = null;

  syncNav(route.name);

  // Each view renders into its own layer and keeps that layer forever, so a
  // view that is still awaiting data (or repainting from a button handler)
  // when the user navigates away paints into its own subtree instead of
  // crashing on markup that was cleared out from under it. Outgoing layers are
  // hidden right away (so nothing flashes double) and dropped once the new
  // view has painted.
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

window.addEventListener('hashchange', render);

/* ---------------- theme ---------------- */

function handleThemeToggle() {
  const next = toggleTheme();
  toast(`Switched to ${next} theme`, '', 'info', 2000);
  store.emit('theme');
}

export { applyTheme, currentTheme };

document.getElementById('btn-theme')?.addEventListener('click', handleThemeToggle);
document.getElementById('btn-theme-mobile')?.addEventListener('click', handleThemeToggle);

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (currentTheme() === 'system') applyTheme('system');
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
}

function paintBadges() {
  const active = store.activeJobs().length;
  const failed = store.jobList().filter(j => j.status === 'failed').length;
  const badge = document.getElementById('nav-badge-mine');
  if (!badge) return;
  badge.hidden = !(active || failed);
  // Active jobs: the count. Failures: the Lucide alert icon plus the count, so
  // the state reads as an icon rather than a punctuation mark. A healthy queue
  // shows nothing at all.
  badge.classList.toggle('hot', Boolean(active));
  badge.classList.toggle('fail', !active && Boolean(failed));
  if (active) badge.textContent = String(active);
  else if (failed) badge.innerHTML = `${icons.alert}<span>${failed}</span>`;
  else badge.textContent = '';
}

store.subscribe((type) => {
  if (['printer', 'connection', 'hello', 'boot', 'resync'].includes(type)) paintStatus();
  if (['job', 'jobDeleted', 'hello', 'boot', 'resync'].includes(type)) paintBadges();
  if (current && current.handle) {
    try { current.handle.update(type, current.params); } catch (e) { console.error('view update failed', e); }
  }
});

/* ---------------- PWA ---------------- */

let installPrompt = null;
const installBtn = document.getElementById('btn-install');

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  if (installBtn) installBtn.hidden = false;
});

installBtn?.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const choice = await installPrompt.userChoice.catch(() => null);
  if (choice && choice.outcome === 'accepted') toast('PrintBridge installed', 'Open it from your home screen', 'ok');
  installPrompt = null;
  installBtn.hidden = true;
});

window.addEventListener('appinstalled', () => { installBtn && (installBtn.hidden = true); });

/* PWA shell. The service worker is update-safe: when a redeployed server
 * activates a new version, this page reloads itself exactly once so nobody
 * ever runs a mix of old HTML and new modules. */
if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  const reloadOnce = (why) => {
    if (!hadController || reloading) return;
    reloading = true;
    console.info(`[pwa] reloading once (${why})`);
    location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => reloadOnce('controllerchange'));
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'printbridge:activated') reloadOnce('new version');
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        reg.update().catch(() => undefined);
        // Long-lived displays (a wall tablet) pick up deploys without a manual refresh.
        setInterval(() => reg.update().catch(() => undefined), 30 * 60 * 1000);
      })
      .catch((e) => console.warn('service worker failed', e));
  });
}

/* ---------------- boot ---------------- */

applyTheme(currentTheme());
paintStatus();
render();

bootstrap().then(() => {
  paintStatus();
  paintBadges();
  if (current && current.handle) current.handle.update('boot');
});

window.addEventListener('online', () => toast('Back online', '', 'ok', 2000));
window.addEventListener('offline', () => toast('Connection lost', 'The server is unreachable', 'err'));

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  if (reason && reason.name === 'ApiError' && reason.status !== 0) {
    toast('Something went wrong', esc(reason.message), 'err');
  }
});

export { store };
