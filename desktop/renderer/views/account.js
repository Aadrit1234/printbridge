/* Account — the owner's side of the console.
 *
 * Two different identities meet in this app and it is worth being explicit about
 * them, because confusing them is the easiest way to lose a printer:
 *
 *   the machine       one username and password per install, signed in on this
 *                     laptop, sees every printer on the machine and every job
 *   the owner account one per licence, created by redeeming the access code
 *                     that was emailed after purchase; sees only its own printers
 *
 * This view is the second one: redeem a code, sign in, and see what the licence
 * covers. Printers registered while it is signed in carry the account id, which
 * is what makes a shop's two machines theirs and nobody else's.
 */

import { api, ownerApi } from '../api.js';
import { esc, icons, toast } from '../../public/app/ui.js';

let host = null;
let mode = 'signup';

export async function render(viewHost) {
  host = viewHost;
  await paint();
  return {
    update() { /* the licence does not change under you */ },
    destroy() { host = null; },
  };
}

async function paint() {
  const session = await ownerApi.session().catch(() => ({ authenticated: false }));
  if (!host) return;
  if (session && session.authenticated) return paintSignedIn(session);
  return paintSignedOut(session);
}

/* ---------------------------------------------------------------- signed out */

async function paintSignedOut(session) {
  const [plans, anything] = await Promise.all([
    ownerApi.plans().catch(() => ({ plans: [] })),
    api.printers().catch(() => ({ printers: [] })),
  ]);
  if (!host) return;

  const list = (plans.plans || []).map((plan) => `
    <li>
      <div class="plan-row">
        <b>${esc(plan.label || plan.id)}</b>
        <span class="plan-price">${esc(plan.price || '')}</span>
      </div>
      <p class="small muted">${esc(plan.note || plan.description || '')}</p>
    </li>`).join('');

  host.innerHTML = `
    <header class="section-head">
      <div>
        <h1>Account</h1>
        <p class="lead">The licence this machine runs on. Buy, then redeem: the access code in your email is
        what creates the account, and the code's plan is what the account gets.</p>
      </div>
    </header>

    <div class="split">
      <section class="card">
        <div class="card-head">
          <h2>${icons.shield}<span>${mode === 'signup' ? 'Redeem your access code' : 'Sign in'}</span></h2>
          <div class="tabs small">
            <button class="tab ${mode === 'signup' ? 'active' : ''}" data-mode="signup" type="button">New licence</button>
            <button class="tab ${mode === 'login' ? 'active' : ''}" data-mode="login" type="button">Already have one</button>
          </div>
        </div>

        ${mode === 'signup' ? `
        <form id="account-signup" class="form">
          <div class="field">
            <label for="ac-code">Access code</label>
            <input class="input" id="ac-code" placeholder="AC-XXXX-XXXX-XXXX" autocomplete="off" required>
          </div>
          <div class="field">
            <label for="ac-name">Name</label>
            <input class="input" id="ac-name" placeholder="Corner Print Shop" autocomplete="organization">
          </div>
          <div class="field">
            <label for="ac-email">Email</label>
            <input class="input" id="ac-email" type="email" placeholder="you@example.com" autocomplete="email" required>
          </div>
          <div class="field">
            <label for="ac-password">Choose a password</label>
            <input class="input" id="ac-password" type="password" autocomplete="new-password" minlength="8" required>
          </div>
          <button class="btn primary" type="submit">Create the account</button>
          <p class="small muted">The code is single-use and can be tied to this email address, so a code sent
          to somebody only works for them.</p>
        </form>` : `
        <form id="account-login" class="form">
          <div class="field">
            <label for="al-email">Email</label>
            <input class="input" id="al-email" type="email" autocomplete="email" required>
          </div>
          <div class="field">
            <label for="al-password">Password</label>
            <input class="input" id="al-password" type="password" autocomplete="current-password" required>
          </div>
          <button class="btn primary" type="submit">Sign in</button>
        </form>`}
        <div class="job-error hidden" id="account-error"></div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>${icons.codes}<span>Licences</span></h2>
          <span class="card-sub">one price per machine, in rupees</span>
        </div>
        <ul class="plan-list">${list || '<li class="empty">The server did not list any plans.</li>'}</ul>
        <p class="small muted">${(anything.printers || []).length} printer(s) registered on this machine in total.
        Printers you register while signed in belong to the account.</p>
      </section>
    </div>
  `;

  host.querySelectorAll('[data-mode]').forEach((tab) => {
    tab.addEventListener('click', () => { mode = tab.dataset.mode; paint(); });
  });

  const fail = (message) => {
    const box = host.querySelector('#account-error');
    if (box) { box.textContent = message; box.classList.remove('hidden'); }
    toast('Could not continue', message, 'err');
  };

  host.querySelector('#account-signup')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = {
      code: host.querySelector('#ac-code').value.trim(),
      name: host.querySelector('#ac-name').value.trim(),
      email: host.querySelector('#ac-email').value.trim(),
      password: host.querySelector('#ac-password').value,
    };
    event.currentTarget.querySelector('button[type="submit"]').disabled = true;
    try {
      await ownerApi.signup(body);
      toast('Account created', 'the licence is now on this machine', 'ok');
      await paint();
    } catch (error) {
      fail(error.message);
      event.currentTarget.querySelector('button[type="submit"]').disabled = false;
    }
  });

  host.querySelector('#account-login')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = {
      email: host.querySelector('#al-email').value.trim(),
      password: host.querySelector('#al-password').value,
    };
    event.currentTarget.querySelector('button[type="submit"]').disabled = true;
    try {
      await ownerApi.login(body);
      await paint();
    } catch (error) {
      fail(error.message);
      event.currentTarget.querySelector('button[type="submit"]').disabled = false;
    }
  });
}

/* ---------------------------------------------------------------- signed in */

async function paintSignedIn(session) {
  const [account, mine] = await Promise.all([
    ownerApi.account().catch(() => null),
    ownerApi.printers().catch(() => ({ printers: [] })),
  ]);
  if (!host) return;

  const a = (account && account.account) || session.account || {};
  const printers = mine.printers || [];

  host.innerHTML = `
    <header class="section-head">
      <div>
        <h1>Account</h1>
        <p class="lead">Signed in as ${esc(a.email || 'an owner')}. Printers registered while this account is
        signed in belong to it.</p>
      </div>
      <div class="row">
        <button class="btn sm ghost" id="account-out">Sign out of the account</button>
      </div>
    </header>

    <div class="split">
      <section class="card">
        <div class="card-head"><h2>${icons.shield}<span>Licence</span></h2></div>
        <dl class="facts">
          <div><dt>Account</dt><dd>${esc(a.email || '—')}</dd></div>
          <div><dt>Name</dt><dd>${esc(a.name || '—')}</dd></div>
          <div><dt>Plan</dt><dd>${esc(a.plan || session.plan || '—')}</dd></div>
          <div><dt>Status</dt><dd>${esc(a.status || (session.active === false ? 'inactive' : 'active'))}</dd></div>
          <div><dt>Since</dt><dd>${esc((a.createdAt || '').slice(0, 10) || '—')}</dd></div>
        </dl>
        <p class="small muted">This machine's own username and password still govern the console. The account is
        the licence and the list of printers that belong to it. Signing in with the account is how you see the licence
        and add printers to it.</p>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>${icons.printer}<span>Printers in this account</span></h2>
          <span class="card-sub">${printers.length} registered</span>
        </div>
        ${printers.length ? `<ul class="list">${printers.map((p) => `
          <li>
            <div class="row" style="gap:8px">
              <b>${esc(p.name)}</b>
              <code class="chip">${esc(p.code)}</code>
              <span class="chip ${p.category === 'shop' ? 'warn' : ''}">${esc(p.category)}</span>
              ${p.active === false ? '<span class="chip danger">paused</span>' : ''}
            </div>
            <p class="small muted">${esc(p.target || 'the machine connection')}${p.note ? ` · ${esc(p.note)}` : ''}</p>
          </li>`).join('')}</ul>`
      : '<p class="empty">Nothing yet. Register a printer on the Printers page while this account is signed in and it becomes yours.</p>'}
      </section>
    </div>
  `;

  host.querySelector('#account-out')?.addEventListener('click', async () => {
    await ownerApi.logout().catch(() => {});
    mode = 'login';
    toast('Signed out of the account');
    await paint();
  });
}
