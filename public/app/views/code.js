/* Print code — type the code from the screen, get the state of that print.
 *
 * This is the page the code exists for: someone reads the code off a phone (or
 * the admin reads it out from the queue) and lands here to see whether that
 * command is queued, printing or already printed.
 */

import { api } from '../api.js';
import { store } from '../store.js';
import { savedCodes, rememberCode } from '../prefs.js';
import { esc, icon, icons, toast, ticketPanel, ticketStateMeta, fmtAgo, note, emptyState } from '../ui.js';

let lookup = { token: null, ticket: null, job: null, error: '', loading: false };

export async function render(container, params, ctx) {
  lookup = { token: params.token ? normalise(params.token) : null, ticket: null, job: null, error: '', loading: false };

  container.innerHTML = shell();
  bind(container, ctx);

  if (lookup.token) await resolve(container);
  else paint(container, ctx);

  return {
    update(type) {
      if (!lookup.token) return;
      if (['job', 'hello', 'resync', 'boot'].includes(type)) {
        // The live job feed is the freshest source when the code is ours.
        const job = store.state.jobs.get(lookup.job ? lookup.job.id : '');
        if (job) {
          lookup.job = job;
          const list = job.tickets || [];
          const found = list.find(t => t.token === lookup.token);
          if (found) lookup.ticket = found;
          paint(container, ctx);
        }
      }
    },
  };
}

/** Accept PB-XXXX-XXXX, pbxxxx-xxxx, or just the eight characters. */
function normalise(value) {
  const raw = String(value || '').toUpperCase().replace(/^PB/, '').replace(/[^0-9A-Z]/g, '');
  if (raw.length !== 8) return String(value || '').toUpperCase();
  return `PB-${raw.slice(0, 4)}-${raw.slice(4)}`;
}

async function resolve(container) {
  lookup.loading = true;
  paint(container);
  try {
    const res = await api.ticket(lookup.token);
    lookup.ticket = res.ticket;
    lookup.job = store.state.jobs.get(res.ticket.jobId) || null;
    rememberCode(res.ticket.token);
    if (lookup.job) store.upsertJob(lookup.job);
  } catch (e) {
    lookup.ticket = null;
    lookup.error = e.message;
  } finally {
    lookup.loading = false;
    paint(container);
  }
}

function shell() {
  return `
  <section class="view">
    <div class="view-head">
      <h1>Print code</h1>
      <p>Every print command gets its own code. Enter one to see whether it is queued, printing or already out.</p>
    </div>

    <div class="card">
      <div class="card-head"><h3>${icon('command')} Enter a code</h3></div>
      <form class="code-finder" id="c-form">
        <div class="field grow">
          <label for="c-input">Code</label>
          <input class="input" id="c-input" placeholder="PB-XXXX-XXXX" autocomplete="off" spellcheck="false" maxlength="16"
                 value="${esc(lookup.token || '')}">
        </div>
        <button class="btn primary" type="submit">${icons.scan}<span>Show</span></button>
      </form>
      <div class="row wrap" id="c-saved" style="margin-top:12px;gap:8px"></div>
    </div>

    <div id="c-result"></div>
  </section>`;
}

function bind(container, ctx) {
  container.querySelector('#c-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = container.querySelector('#c-input').value.trim();
    if (!value) return;
    ctx.navigate(`#/code/${encodeURIComponent(value)}`);
  });
}

function paint(container, ctx) {
  const saved = container.querySelector('#c-saved');
  if (saved) {
    const codes = savedCodes();
    saved.innerHTML = codes.length
      ? `<span class="small muted">Your recent codes:</span>${codes.slice(0, 8).map(c => `<a class="code-inline" href="#/code/${encodeURIComponent(c)}">${esc(c)}</a>`).join('')}`
      : '<span class="small muted">Codes you print will be listed here.</span>';
  }

  const host = container.querySelector('#c-result');
  if (!host) return;

  if (!lookup.token) {
    host.innerHTML = emptyState({
      iconName: 'scan',
      title: 'No code entered yet',
      text: 'Press Print on a document and the code appears on that screen — it is also in your history.',
      action: '<a class="btn" href="#/history">Open my prints</a>',
    });
    return;
  }

  if (lookup.loading) {
    host.innerHTML = '<div class="card"><div class="skeleton-block" style="height:180px"></div></div>';
    return;
  }

  if (!lookup.ticket) {
    host.innerHTML = `<div class="card">
      ${note(esc(lookup.error || 'No print with that code belongs to this device. Codes are private to the device that made them.'), 'warn')}
      <div class="row" style="margin-top:12px"><a class="btn sm ghost" href="#/history">Open my prints</a></div>
    </div>`;
    return;
  }

  const job = lookup.job || { name: lookup.ticket.jobName || 'Document', id: lookup.ticket.jobId };
  const state = ticketStateMeta(lookup.ticket.state);

  host.innerHTML = `
    ${ticketPanel({
      job,
      ticket: lookup.ticket,
      actions: lookup.job ? `<a class="btn sm soft" href="#/job/${esc(lookup.job.id)}">${icons.scan}<span>Open the preview</span></a>` : '',
    })}
    <div class="card" style="margin-top:16px">
      <div class="spread wrap">
        <div>
          <strong>${esc(job.name || 'Document')}</strong>
          <div class="small muted">
            ${job.pageCount ? `${job.pageCount} page${job.pageCount === 1 ? '' : 's'} · ` : ''}
            opened ${esc(fmtAgo(lookup.ticket.at))}${lookup.ticket.updatedAt && lookup.ticket.updatedAt !== lookup.ticket.at ? ` · updated ${esc(fmtAgo(lookup.ticket.updatedAt))}` : ''}
          </div>
        </div>
        <span class="chip ${state.cls}">${esc(state.label)}</span>
      </div>
      ${lookup.ticket.state === 'printed'
        ? `<div style="margin-top:12px">${note('This print command finished — the document was handed to the printer.', 'ok')}</div>`
        : lookup.ticket.state === 'waiting'
          ? `<div style="margin-top:12px">${note('The printer is not answering yet. This print stays in the queue and goes out as soon as the printer is back.', 'warn')}</div>`
          : ''}
    </div>`;

  // live updates for a code that is still moving
  if (!['printed', 'failed', 'canceled'].includes(lookup.ticket.state)) {
    const tick = setInterval(async () => {
      try {
        const res = await api.ticket(lookup.token);
        const changed = !lookup.ticket || res.ticket.state !== lookup.ticket.state
          || res.ticket.updatedAt !== lookup.ticket.updatedAt;
        lookup.ticket = res.ticket;
        lookup.job = store.state.jobs.get(res.ticket.jobId) || lookup.job;
        if (changed) paint(container, ctx);
      } catch { /* the stream still covers our own jobs */ }
    }, 5000);
    container._cleanup = () => clearInterval(tick);
  }
}
