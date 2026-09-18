/* The owner page — sign up with an access code, or sign in.
 *
 * Small on purpose. Everything that decides anything (is this code valid, has
 * it been used, what plan does it carry, does this password match) happens on
 * the server; this file only collects input, shows what came back, and keeps
 * the cookie. The Electron console will render the same calls.
 */

import { applyTheme, resolvedTheme, toggleTheme } from '../app/theme.js';

const $ = (sel, el) => (el || document).querySelector(sel);

const CFG = window.PRINTBRIDGE_CONFIG || {};
const ORIGIN = String(CFG.apiBase || '').replace(/\/+$/, '');
const BASE = ORIGIN + '/api/owner';

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    /* The session is a cookie, and on a static host the API is another origin. */
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((payload && payload.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

/* ------------------------------------------------------------------ feedback */

let msgTimer = null;

function say(text, kind = '') {
  const host = $('#gate-msg');
  host.className = 'note' + (kind ? ' ' + kind : '');
  host.innerHTML = esc(text);
  host.hidden = false;
  if (msgTimer) clearTimeout(msgTimer);
  if (kind === 'ok') msgTimer = setTimeout(() => { host.hidden = true; }, 6000);
}

function busy(button, on, label) {
  if (!button) return;
  if (on) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    button.textContent = label || 'Working…';
  } else {
    button.disabled = false;
    button.textContent = button.dataset.label || button.textContent;
  }
}

/* --------------------------------------------------------------------- tabs */

function selectTab(name) {
  for (const button of document.querySelectorAll('#gate-tabs button')) {
    button.classList.toggle('active', button.getAttribute('data-tab') === name);
  }
  $('#pane-signup').hidden = name !== 'signup';
  $('#pane-login').hidden = name !== 'login';
  $('#gate-title').textContent = name === 'signup' ? 'Create your account' : 'Welcome back';
  $('#gate-msg').hidden = true;
}

/* ------------------------------------------------------------------- views */

function showAccount(account) {
  $('#signed-out').hidden = true;
  $('#signed-in').hidden = false;
  $('#ac-name').textContent = account.name || account.email;
  $('#ac-email').textContent = account.email;
  $('#ac-plan').textContent = account.planTerm
    ? `${account.planLabel || account.plan} · ${account.planTerm}`
    : (account.planLabel || account.plan);
  $('#ac-status').textContent = account.status === 'active' ? 'Active' : account.status;
}

function showGate() {
  $('#signed-in').hidden = true;
  $('#signed-out').hidden = false;
}

async function refresh() {
  try {
    const session = await api('/session');
    if (session.authenticated && session.account) showAccount(session.account);
    else showGate();
  } catch (e) {
    showGate();
    if (e.status && e.status !== 401) say(e.message, 'bad');
  }
}

/* ------------------------------------------------------------------- plans */

const MONEY = (amount, currency) => `${currency === 'INR' ? '\u20B9' : currency + ' '}${Number(amount).toLocaleString('en-IN')}`;

async function loadPlans() {
  try {
    const { plans } = await api('/plans');
    $('#plan-rows').innerHTML = plans.map(p => (
      '<div class="line"><span>' + esc(p.label) + (p.term === 'lifetime' ? ' · lifetime' : ' · per year') + '</span>' +
      '<b>' + esc(MONEY(p.amount, p.currency)) + '</b></div>'
    )).join('');
  } catch {
    $('#plan-rows').innerHTML = '<div class="line"><span>Licences unavailable</span><b>—</b></div>';
  }
}

/* ------------------------------------------------------------------ actions */

function normalizeCode(value) {
  /* Just cosmetic while typing: the server accepts it any way it is written. */
  const raw = String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const body = raw.startsWith('AC') ? raw.slice(2) : raw;
  const parts = [];
  for (let i = 0; i < 3; i++) parts.push(body.slice(i * 4, i * 4 + 4));
  return 'AC-' + parts.filter(Boolean).join('-');
}

async function signUp(button) {
  const body = {
    code: $('#su-code').value.trim(),
    name: $('#su-name').value.trim(),
    email: $('#su-email').value.trim(),
    password: $('#su-password').value,
  };
  if (!body.code) return say('Enter the access code from your licence email.', 'bad');
  if (!body.email) return say('Enter the email address this code was sent to.', 'bad');
  if (body.password.length < 8) return say('Choose a password of at least 8 characters.', 'bad');

  busy(button, true, 'Creating your account…');
  try {
    const res = await api('/signup', { method: 'POST', body });
    showAccount(res.account);
    $('#su-password').value = '';
  } catch (e) {
    say(e.message, 'bad');
    busy(button, false);
  }
}

async function signIn(button) {
  const body = { email: $('#li-email').value.trim(), password: $('#li-password').value };
  if (!body.email || !body.password) return say('Enter your email and password.', 'bad');

  busy(button, true, 'Signing in…');
  try {
    const res = await api('/login', { method: 'POST', body });
    showAccount(res.account);
    $('#li-password').value = '';
  } catch (e) {
    say(e.message, 'bad');
    busy(button, false);
  }
}

/* -------------------------------------------------------------------- theme */

function paintTheme() {
  const light = resolvedTheme() === 'light';
  $('#theme-glyph').innerHTML = light
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"/></svg>';
  $('#theme-toggle').setAttribute('aria-label', light ? 'Use the dark theme' : 'Use the light theme');
}

/* --------------------------------------------------------------------- wire */

document.querySelectorAll('#gate-tabs button').forEach(button => {
  button.addEventListener('click', () => selectTab(button.getAttribute('data-tab')));
});

$('#su-go').addEventListener('click', (e) => signUp(e.currentTarget));
$('#li-go').addEventListener('click', (e) => signIn(e.currentTarget));

$('#su-code').addEventListener('input', (e) => { e.target.value = normalizeCode(e.target.value); });

for (const [input, button] of [['#su-password', '#su-go'], ['#li-password', '#li-go']]) {
  $(input).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $(button).click(); }
  });
}

$('#sign-out').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); } catch { /* sign out locally anyway */ }
  showGate();
  say('Signed out.', 'ok');
});

$('#theme-toggle').addEventListener('click', () => {
  toggleTheme();
  paintTheme();
});

/* A code can arrive in the link, e.g. /owner?code=AC-… straight from the email. */
try {
  const invited = new URLSearchParams(location.search).get('code');
  if (invited) {
    $('#su-code').value = normalizeCode(invited);
    selectTab('signup');
  }
} catch { /* no query string to read */ }

applyTheme(localStorage.getItem('pb.theme') || 'system');
paintTheme();
loadPlans();
refresh();
