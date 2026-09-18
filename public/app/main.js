/* Guest app controller — routes, live status, theme, PWA.
 *
 * This bundle is the whole public surface: print something, follow its code,
 * read your own history. There is intentionally no admin route, no admin link
 * and no admin code in here — a phone that opens this page cannot even find
 * the control room.
 */

import { api } from './api.js';
import { bootstrap, store } from './store.js';
import { applyTheme, currentTheme, toggleTheme } from './theme.js';
import { esc, icons, setThumbUrlBuilder, toast } from './ui.js';

// Thumbnails need the device id, which only this client knows how to attach.
setThumbUrlBuilder(api.thumbUrl);

import * as printView from './views/print.js';
import * as jobView from './views/job.js';
import * as historyView from './views/history.js';
import * as codeView from './views/code.js';

const routes = [
  { match: /^#\/print\/?$/, view: printView, name: 'print', title: 'Print' },
  { match: /^#\/job\/([\w-]+)$/, view: jobView, name: 'job', title: 'Your print', nav: 'print', params: m => ({ id: m[1] }) },
  { match: /^#\/history\/?$/, view: historyView, name: 'history', title: 'My prints' },
  { match: /^#\/code\/?$/, view: codeView, name: 'code', title: 'Print code' },
  { match: /^#\/code\/([0-9A-Za-z-]+)$/, view: codeView, name: 'code', title: 'Print code', params: m => ({ token: m[1] }) },
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

export async function navigate(hash, { replace = false } = {}) {
  if (replace) location.replace(hash);
  else location.hash = hash;
}

function syncNav(name) {
  const active = name === 'job' ? 'print' : name;
  for (const link of document.querySelectorAll('[data-route]')) {
    link.classList.toggle('active', link.dataset.route === active);
  }
  const title = document.getElementById('topbar-title');
  const resolved = routes.find(r => r.name === name);
  if (title && resolved) title.textContent = resolved.title;
}

async function render() {
  const { route, params } = resolveRoute();

  if (current && current.destroy) {
    try { current.destroy(); } catch (e) { console.error('view teardown failed', e); }
  }
  current = null;
  syncNav(route.name);

  // Each view paints into its own layer and keeps it forever, so a view that is
  // still awaiting data when the user navigates away cannot crash on markup
  // that was cleared underneath it. Outgoing layers hide at once, then drop.
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
  viewHost.scrollTop = 0;
}

window.addEventListener('hashchange', render);

/* ---------------- theme ---------------- */

function handleThemeToggle() {
  const next = toggleTheme();
  toast(`Switched to ${next} theme`, '', 'info', 1800);
  store.emit('theme');
}

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
  const rail = document.getElementById('rail-printer');

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
  if (rail) {
    rail.textContent = printer
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

window.addEventListener('appinstalled', () => { if (installBtn) installBtn.hidden = true; });

/* The service worker is update-safe: when a redeployed server activates a new
 * version, the page reloads itself exactly once so nobody runs a mix of old
 * HTML and new modules. */
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

window.addEventListener('online', () => toast('Back online', '', 'ok', 1800));
window.addEventListener('offline', () => toast('Connection lost', 'The server is unreachable', 'err'));

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  if (reason && reason.name === 'ApiError' && reason.status !== 0) {
    toast('Something went wrong', esc(reason.message), 'err');
  }
});

export { store };
