/* Print codes — every print command, by the code the sender was given.
 *
 * This is the admin counterpart to the code the guest sees: one row per print
 * command (not per document), so a reprint shows up on its own with its own
 * code, and the state column answers exactly the question somebody asks at the
 * printer: is my job queued, printing, or already out?
 */

import { api } from '../api.js';
import { store } from '../store.js';
import {
  esc, icons, toast, confirmDialog, emptyState, fmtAgo, fmtDateTime,
  ticketsOf, ticketStateMeta, printCode,
} from '../../app/ui.js';

let filter = 'all'; // all | active | printed | failed
let query = '';

export async function render(container, _params, ctx) {
  container.innerHTML = shell();
  bind(container, ctx);
  paint(container, ctx);
  return {
    update: (type) => {
      if (['job', 'jobDeleted', 'hello', 'resync', 'boot', 'connection'].includes(type)) paint(container, ctx);
    },
  };
}

function shell() {
  return `
  <section class="view">
    <div class="view-head spread wrap">
      <div>
        <h1>Print codes</h1>
        <p>Every print command gets its own code. This is the list the person holding the paper is looking at.</p>
      </div>
      <div class="row">
        <span class="chip" id="c-connection">connecting</span>
        <button class="btn sm ghost" id="c-refresh">${icons.refresh}<span>Refresh</span></button>
      </div>
    </div>

    <div class="card">
      <div class="spread wrap" style="margin-bottom:14px">
        <div class="tabs" id="c-filters">
          <button data-filter="all" class="active">All</button>
          <button data-filter="active">In the printer</button>
          <button data-filter="printed">Printed</button>
          <button data-filter="failed">Failed</button>
        </div>
        <div class="field" style="min-width:220px">
          <input class="input mono" id="c-search" placeholder="Find a code…" autocomplete="off" spellcheck="false">
        </div>
      </div>
      <div class="row wrap" id="c-stats" style="gap:8px;margin-bottom:14px"></div>
      <div id="c-list"></div>
    </div>
  </section>`;
}

function bind(container, ctx) {
  container.querySelectorAll('#c-filters button').forEach(btn => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter;
      container.querySelectorAll('#c-filters button').forEach(b => b.classList.toggle('active', b === btn));
      paint(container, ctx);
    });
  });

  container.querySelector('#c-search').addEventListener('input', (event) => {
    query = event.target.value.trim().toUpperCase();
    paint(container, ctx);
  });

  container.querySelector('#c-refresh').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const res = await api.jobs(300);
      store.state.jobs.clear();
      for (const job of res.jobs) store.upsertJob(job);
      paint(container, ctx);
      toast('Codes refreshed');
    } catch (e) {
      toast('Could not refresh', e.message, 'err');
    } finally {
      button.disabled = false;
    }
  });

  container.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const job = store.state.jobs.get(button.dataset.id);
    if (!job) return;
    button.disabled = true;
    try {
      if (button.dataset.act === 'cancel') {
        await api.cancel(job.id);
        toast('Print stopped', button.dataset.token || '');
      }
      if (button.dataset.act === 'reprint') {
        const updated = await api.print(job.id, {});
        store.upsertJob(updated);
        toast('Print command sent', updated.token ? `New code ${updated.token}` : '');
      }
      if (button.dataset.act === 'delete') {
        const ok = await confirmDialog({
          title: 'Delete this print?',
          message: `"${job.name}" and its files are removed from the server.`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) { button.disabled = false; return; }
        await api.remove(job.id);
        store.state.jobs.delete(job.id);
        store.emit('jobDeleted', job.id);
        toast('Deleted');
      }
    } catch (e) {
      toast('Action failed', e.message, 'err');
    } finally {
      button.disabled = false;
    }
  });

  container.addEventListener('click', (event) => {
    const copy = event.target.closest('[data-copy]');
    if (!copy) return;
    navigator.clipboard.writeText(copy.dataset.copy)
      .then(() => toast('Copied', copy.dataset.copy, 'ok', 2000))
      .catch(() => toast('Copy it by hand', copy.dataset.copy, 'info', 3000));
  });
}

/** Flatten every job into one entry per print command. */
function allCommands() {
  const rows = [];
  for (const job of store.jobList()) {
    const tickets = ticketsOf(job);
    for (const ticket of tickets) {
      rows.push({
        token: ticket.token,
        state: ticket.state,
        at: ticket.at,
        updatedAt: ticket.updatedAt,
        target: ticket.targetName || ticket.target || null,
        copies: ticket.copies,
        message: ticket.message || ticket.error || '',
        job,
      });
    }
  }
  return rows.sort((a, b) => (a.at < b.at ? 1 : -1));
}

function visible(rows) {
  let list = rows;
  if (filter === 'active') list = rows.filter(r => ['queued', 'waiting', 'printing'].includes(r.state));
  if (filter === 'printed') list = rows.filter(r => r.state === 'printed');
  if (filter === 'failed') list = rows.filter(r => r.state === 'failed');
  if (query) {
    const needle = query.replace(/[^0-9A-Z]/g, '');
    list = list.filter(r => r.token && (r.token.includes(query) || r.token.replace(/[^0-9A-Z]/g, '').includes(needle)));
  }
  return list;
}

function paint(container, ctx) {
  const connection = container.querySelector('#c-connection');
  if (connection) {
    const live = store.state.connection === 'live';
    connection.className = `chip ${live ? 'live' : 'offline'}`;
    connection.textContent = live ? 'live' : 'reconnecting…';
  }

  const rows = allCommands();
  const stats = container.querySelector('#c-stats');
  if (stats) {
    const count = (state) => rows.filter(r => (Array.isArray(state) ? state.includes(r.state) : r.state === state)).length;
    stats.innerHTML = `
      <span class="chip ${count(['queued', 'waiting']) ? 'queued' : ''}">${count(['queued', 'waiting'])} queued</span>
      <span class="chip ${count('printing') ? 'printing' : ''}">${count('printing')} printing</span>
      <span class="chip printed">${count('printed')} printed</span>
      <span class="chip ${count('failed') ? 'failed' : ''}">${count('failed')} failed</span>`;
  }

  const host = container.querySelector('#c-list');
  const list = visible(rows);

  if (!list.length) {
    host.innerHTML = emptyState({
      iconName: 'command',
      title: rows.length ? 'No codes match that' : 'No print commands yet',
      text: rows.length
        ? 'Try another filter, or clear the search box.'
        : 'When someone presses Print on the guest page, its code shows up here with its state.',
    });
    return;
  }

  host.innerHTML = `<div class="job-list reveal">${list.map(row => rowMarkup(row)).join('')}</div>`;
}

function rowMarkup(row) {
  const meta = ticketStateMeta(row.state);
  const active = ['queued', 'waiting', 'printing'].includes(row.state);
  const job = row.job;

  const actions = [
    active
      ? `<button class="btn sm ghost" data-act="cancel" data-id="${esc(job.id)}" data-token="${esc(row.token)}">${icons.x}<span>Stop</span></button>`
      : `<button class="btn sm soft" data-act="reprint" data-id="${esc(job.id)}">${icons.play}<span>Print again</span></button>`,
    !active ? `<button class="btn sm ghost" data-act="delete" data-id="${esc(job.id)}">${icons.trash}</button>` : '',
  ].filter(Boolean).join('');

  return `
    <div class="job-row">
      <div class="job-thumb">${icons.file}</div>
      <div class="job-info">
        <div class="job-title">
          ${printCode(row.token)}
          <span class="chip ${meta.cls}">${esc(meta.label)}</span>
        </div>
        <div class="job-meta">
          <span class="truncate">${esc(job.name)}</span>
          <span>${job.pageCount ? `${job.pageCount} page${job.pageCount === 1 ? '' : 's'}` : 'preparing'}</span>
          ${row.copies ? `<span>${row.copies}×</span>` : ''}
          <span>${esc(fmtDateTime(row.at))}</span>
          <span class="muted">${esc(fmtAgo(row.updatedAt || row.at))}</span>
          ${job.owner ? `<span class="device-chip" title="Sent by ${esc(job.owner)}">${esc(job.owner.slice(4, 10))}</span>` : '<span class="device-chip">server</span>'}
          ${row.target ? `<span>→ ${esc(String(row.target).replace(/^[a-z]+:/i, ''))}</span>` : ''}
        </div>
        ${row.message ? `<div class="job-note">${esc(row.message)}</div>` : ''}
      </div>
      <div class="job-side">
        <button class="btn sm ghost" data-copy="${esc(row.token)}" title="Copy the code">${icons.copy}</button>
        <div class="job-actions">${actions}</div>
      </div>
    </div>`;
}
