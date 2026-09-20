/* Access view — who may control this machine.
 *
 * Everything a guest cannot do lives behind this console's sign-in. This page
 * sets that sign-in, manages the sessions that are signed in, and hands out the
 * guest link (with its QR card) without ever exposing a password. */

import { api } from '../api.js';
import {
  esc, icon, icons, toast, note, copyText, confirmDialog, fmtAgo, fmtUntil,
} from '../../app/ui.js';

let status = null;
let links = null;

export async function render(container, _params, _ctx) {
  container.innerHTML = shell();
  bind(container);
  await refresh(container);
  return {
    update: (type) => { if (['settings', 'boot'].includes(type)) paint(container); },
  };
}

async function refresh(container) {
  try {
    const [session, guest] = await Promise.all([api.session(), api.guestLink()]);
    status = session;
    links = guest;
  } catch (e) {
    toast('Could not read access settings', e.message, 'err');
  }
  paint(container);
}

function shell() {
  return `
  <section class="view">
    <div class="view-head">
      <h1>Access</h1>
      <p>Guests print freely; everything else needs the sign-in for this machine. Share the guest link,
      keep the password to yourself.</p>
    </div>

    <div class="two-col">
      <div class="card" id="a-gate"></div>
      <div class="card" id="a-share"></div>
    </div>

    <div class="card" id="a-pin"></div>
    <div class="card" id="a-sessions"></div>
  </section>`;
}

function bind(container) {
  container.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const act = button.dataset.act;

    if (act === 'copy-guest') {
      await copyText(links ? links.url : location.origin, 'Guest link copied');
      return;
    }

    if (act === 'print-card') {
      button.disabled = true;
      try {
        await api.printQrCard();
        toast('QR card queued', 'Print it and tape it next to the printer');
      } catch (e) {
        toast('Could not print the card', e.message, 'err', 7000);
      }
      button.disabled = false;
      return;
    }

    if (act === 'save-gate') {
      const toggle = container.querySelector('#a-protect');
      const days = container.querySelector('#a-session-days');
      button.disabled = true;
      try {
        const settings = await api.updateSettings({
          adminProtect: toggle.checked,
          sessionDays: Number(days.value) || 30,
        });
        status = await api.session();
        toast(settings.adminProtect ? 'A sign-in is required for this console' : 'This console is open to the network',
          settings.adminProtect ? 'Guests still cannot reach it' : 'Anyone on this network can control the printer',
          settings.adminProtect ? 'ok' : 'info', 6000);
        paint(container);
      } catch (e) {
        toast('Could not save', e.message, 'err');
      }
      button.disabled = false;
      return;
    }

    if (act === 'set-credentials') {
      const username = container.querySelector('#a-user').value.trim();
      const current = container.querySelector('#a-current').value;
      const next = container.querySelector('#a-next').value;
      const again = container.querySelector('#a-again').value;
      const error = container.querySelector('#a-error');

      const fail = (message) => {
        error.textContent = message;
        error.classList.remove('hidden');
      };
      error.classList.add('hidden');

      if (!username) return fail('Choose a username');
      if (!current) return fail('Enter the password you signed in with');
      if (next.length < 6) return fail('A password is at least 6 characters');
      if (next !== again) return fail('The two new passwords do not match');
      if (next === current) return fail('That is the password you already have');

      button.disabled = true;
      try {
        const res = await api.setCredentials({ currentPassword: current, username, password: next });
        toast('Sign-in updated', res.note || 'Other devices were signed out');
        container.querySelector('#a-current').value = '';
        container.querySelector('#a-next').value = '';
        container.querySelector('#a-again').value = '';
        await refresh(container);
      } catch (e) {
        fail(e.message);
      }
      button.disabled = false;
      return;
    }

    if (act === 'revoke-others') {
      button.disabled = true;
      try {
        const res = await api.signOutOtherDevices();
        toast('Other devices signed out', res.note || '');
        await refresh(container);
      } catch (e) {
        toast('Could not sign out', e.message, 'err');
      }
      button.disabled = false;
      return;
    }

    if (act === 'close-all') {
      const ok = await confirmDialog({
        title: 'Sign out everywhere?',
        message: 'Every device — including this one — will need to sign in again.',
        confirmLabel: 'Sign out all',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.closeAllSessions();
        location.reload();
      } catch (e) {
        toast('Could not sign out', e.message, 'err');
      }
    }
  });
}

/* ---------------- painting ---------------- */

function paint(container) {
  paintGate(container);
  paintShare(container);
  paintCredentials(container);
  paintSessions(container);
}

function paintGate(container) {
  const host = container.querySelector('#a-gate');
  if (!host || !status) return;
  const on = status.protected;

  host.innerHTML = `
    <div class="card-head">${icon('shield')}<h2>Admin gate</h2></div>
    <div class="gate-state ${on ? '' : 'open'}">
      ${on ? icons.shield : icons.alert}
      <div>
        <div><b>${on ? 'Sign-in required' : 'Open to the network'}</b></div>
        <div class="muted small">${on
          ? 'Visitors can print, but only a signed-in owner can change anything.'
          : 'Anyone who can reach /admin can control the printer right now.'}</div>
      </div>
    </div>
    <label class="opt-label" style="margin-top:14px">Require a sign-in for this console</label>
    <label class="check-row">
      <input type="checkbox" id="a-protect" ${on ? 'checked' : ''}>
      <span>${on ? 'On' : 'Off — trusted network only'}</span>
    </label>
    <label class="opt-label" style="margin-top:12px">Stay signed in for (days)</label>
    <input class="input" id="a-session-days" type="number" min="1" max="365" value="${esc(String(status.sessionDays || 30))}">
    <button class="btn primary" data-act="save-gate" style="margin-top:12px">${icons.check}<span>Save</span></button>
    ${on ? '' : note('With the gate off, anyone on this Wi-Fi can change the printer and see every document. Turn it back on when you are done.', 'warn')}`;
}

function paintShare(container) {
  const host = container.querySelector('#a-share');
  if (!host || !links) return;
  host.innerHTML = `
    <div class="card-head">${icon('scan')}<h2>Guest link</h2></div>
    <div class="qr-panel">
      <img src="${api.qrUrl(links.url)}" alt="QR code for the guest print page" width="180" height="180">
      <div class="stack" style="gap:8px;min-width:0">
        <code class="mono small" style="word-break:break-all">${esc(links.url)}</code>
        <div class="row wrap" style="gap:6px">
          <button class="btn sm soft" data-act="copy-guest">${icons.copy}<span>Copy link</span></button>
          <button class="btn sm" data-act="print-card">${icons.printer}<span>Print QR card</span></button>
          <a class="btn sm ghost" href="${api.cardUrl(links.url)}" target="_blank" rel="noopener">${icons.download}<span>Poster PDF</span></a>
        </div>
      </div>
    </div>
    ${note('This link opens the guest page only. It can never reach the console, and it carries no session.', 'info')}`;
}

function paintCredentials(container) {
  const host = container.querySelector('#a-pin');
  if (!host || !status) return;
  /* Why this card exists: the console is a desktop app now, and a desktop app
   * that asks for six digits is a kiosk. This machine's sign-in is a username
   * and a password, like everything else on the laptop it lives on. */
  host.innerHTML = `
    <div class="card-head">${icon('shield')}<h2>Sign-in for this machine</h2>
      <span class="grow"></span>
      ${status.needsSetup ? '<span class="chip warn">still the first-run one</span>' : ''}
    </div>
    <div class="muted small" style="margin-bottom:12px">
      ${status.username ? `Currently <b>${esc(status.username)}</b>. ` : ''}
      ${status.updatedAt ? `Last changed ${esc(fmtAgo(status.updatedAt))}. ` : ''}
      Changing it signs every other device out. An owner account — an email and password — can also open this
      console, but only this machine's sign-in can change it.
    </div>
    <div class="stack" style="gap:12px;max-width:520px">
      <div class="two-col">
        <label class="opt-block"><span class="opt-label">Username</span>
          <input class="input" id="a-user" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" value="${esc(status.username || 'admin')}">
        </label>
        <label class="opt-block"><span class="opt-label">Password you signed in with</span>
          <input class="input" id="a-current" type="password" autocomplete="current-password">
        </label>
      </div>
      <div class="two-col">
        <label class="opt-block"><span class="opt-label">New password</span>
          <input class="input" id="a-next" type="password" autocomplete="new-password" placeholder="at least 6 characters">
        </label>
        <label class="opt-block"><span class="opt-label">Repeat new password</span>
          <input class="input" id="a-again" type="password" autocomplete="new-password">
        </label>
      </div>
      <div id="a-error" class="job-error hidden"></div>
      <div class="row">
        <button class="btn primary" data-act="set-credentials">${icons.check}<span>Update sign-in</span></button>
      </div>
    </div>`;
}

function paintSessions(container) {
  const host = container.querySelector('#a-sessions');
  if (!host || !status) return;
  host.innerHTML = `
    <div class="card-head">${icon('list')}<h2>Sessions</h2>
      <span class="grow"></span>
      <span class="chip">${status.authenticated ? 'this device signed in' : 'not signed in'}</span>
    </div>
    <div class="session-row session-current">
      ${icons.check}
      <div class="grow">
        <div><b>This device</b></div>
        <div class="session-meta">${status.expiresAt ? `expires ${esc(fmtUntil(status.expiresAt))}` : 'open access'} · ${esc(String(status.sessionDays))}-day sessions</div>
      </div>
    </div>
    <div class="row wrap" style="gap:8px;margin-top:14px">
      <button class="btn sm" data-act="revoke-others">${icons.retry}<span>Sign out other devices</span></button>
      <button class="btn sm danger" data-act="close-all">${icons.x}<span>Sign out everywhere</span></button>
    </div>
    ${note('Sessions survive a server restart, so a wall tablet stays signed in. Lost phone? Sign out everywhere and set a new password.', 'info')}`;
}
