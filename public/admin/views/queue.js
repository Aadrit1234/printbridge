/* Queue view — live status of everything in flight and in history. */

import { api } from '../api.js';
import { store } from '../store.js';
import {
  esc, icon, icons, toast, jobRow, confirmDialog, emptyState,
  statusMeta, ACTIVE_STATUSES, fmtAgo,
} from '../../app/ui.js';

let filter = 'all'; // all | active | failed | printed

export async function render(container, _params, ctx) {
  container.innerHTML = shell();
  bind(container, ctx);
  paint(container, ctx);
  return { update: (type) => { if (['job', 'jobDeleted', 'hello', 'resync', 'boot', 'connection'].includes(type)) paint(container, ctx); } };
}

function shell() {
  return `
  <section class="view">
    <div class="view-head spread wrap">
      <div>
        <h1>Queue</h1>
        <p>Live status for every job — updates arrive instantly, no refresh needed.</p>
      </div>
      <div class="row">
        <span class="chip" id="q-connection">connecting</span>
        <button class="btn sm ghost" id="q-clear">${icons.trash}<span>Clear finished</span></button>
      </div>
    </div>

    <div class="card">
      <div class="spread wrap" style="margin-bottom:12px">
        <div class="tabs" id="q-filters" style="max-width:420px">
          <button data-filter="all" class="active">All</button>
          <button data-filter="active">Active</button>
          <button data-filter="failed">Failed</button>
          <button data-filter="printed">Printed</button>
        </div>
        <div class="row" id="q-stats"></div>
      </div>
      <div id="q-list"></div>
    </div>

    <div class="card" id="q-outbox-card"></div>
  </section>`;
}

function bind(container, ctx) {
  container.querySelectorAll('#q-filters button').forEach(btn => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter;
      container.querySelectorAll('#q-filters button').forEach(b => b.classList.toggle('active', b === btn));
      paint(container, ctx);
    });
  });

  container.querySelector('#q-clear').addEventListener('click', async (event) => {
    const finished = store.jobList().filter(j => !ACTIVE_STATUSES.includes(j.status));
    if (!finished.length) return toast('Nothing to clear', '', 'info');
    const ok = await confirmDialog({
      title: `Remove ${finished.length} finished job(s)?`,
      message: 'The history entries and their files will be deleted from the server.',
      confirmLabel: 'Clear',
      danger: true,
    });
    if (!ok) return;
    event.currentTarget.disabled = true;
    try {
      const res = await api.clearFinished();
      for (const job of finished) store.state.jobs.delete(job.id);
      store.emit('jobDeleted');
      toast(`Cleared ${res.removed} job(s)`);
    } catch (e) {
      toast('Could not clear', e.message, 'err');
    } finally {
      event.currentTarget.disabled = false;
    }
  });
}

function visibleJobs() {
  const jobs = store.jobList();
  if (filter === 'active') return jobs.filter(j => ACTIVE_STATUSES.includes(j.status));
  if (filter === 'failed') return jobs.filter(j => j.status === 'failed');
  if (filter === 'printed') return jobs.filter(j => j.status === 'printed');
  return jobs;
}

function paint(container, ctx) {
  const connection = container.querySelector('#q-connection');
  if (connection) {
    const live = store.state.connection === 'live';
    connection.className = `chip ${live ? 'live' : 'offline'}`;
    connection.textContent = live ? 'live' : 'reconnecting…';
  }

  const all = store.jobList();
  const stats = container.querySelector('#q-stats');
  if (stats) {
    const active = all.filter(j => ACTIVE_STATUSES.includes(j.status)).length;
    const failed = all.filter(j => j.status === 'failed').length;
    const printed = all.filter(j => j.status === 'printed').length;
    stats.innerHTML = `
      <span class="chip ${active ? 'printing' : ''}">${active} active</span>
      <span class="chip ${failed ? 'failed' : ''}">${failed} failed</span>
      <span class="chip printed">${printed} printed</span>`;
  }

  const list = container.querySelector('#q-list');
  const jobs = visibleJobs();

  if (!jobs.length) {
    list.innerHTML = emptyState({
      iconName: 'queue',
      title: filter === 'all' ? 'The queue is empty' : 'Nothing matches this filter',
      text: filter === 'all' ? 'Upload a document and it will appear here with live progress.' : 'Try a different filter.',
      action: '<a class="btn primary" href="#/print">Print something</a>',
    });
  } else {
    list.innerHTML = groupByDay(jobs);
    list.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { act, id } = btn.dataset;
        btn.disabled = true;
        try {
          if (act === 'print' || act === 'retry') {
            await (act === 'retry' ? api.retry(id) : api.print(id, {}));
            toast(act === 'retry' ? 'Queued again' : 'Sent to the printer');
          }
          if (act === 'cancel') { await api.cancel(id); toast('Job canceled'); }
          if (act === 'delete') {
            await api.remove(id);
            store.state.jobs.delete(id);
            store.emit('jobDeleted', id);
            toast('Job deleted');
          }
        } catch (e) {
          toast('Action failed', e.message, 'err');
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  paintOutbox(container);
}

function groupByDay(jobs) {
  const today = [];
  const earlier = [];
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  for (const job of jobs) {
    (new Date(job.createdAt) >= startOfToday ? today : earlier).push(job);
  }

  // Who sent it matters here: the admin sees every device, the guest sees one.
  const section = (label, list) => list.length
    ? `<div class="group-label">${esc(label)}</div><div class="job-list">${list.map(j => jobRow(j, {
      actions: actionsFor(j),
      extra: j.owner
        ? `<span class="device-chip" title="Sent by ${esc(j.owner)}">${esc(j.owner.slice(4, 10))}</span>`
        : '<span class="device-chip" title="Created by the server">server</span>',
    })).join('')}</div>`
    : '';

  return section('Today', today) + section('Earlier', earlier);
}

function actionsFor(job) {
  const buttons = [];
  const active = ACTIVE_STATUSES.includes(job.status);
  if (active) {
    buttons.push(`<button class="btn sm ghost" data-act="cancel" data-id="${esc(job.id)}">Cancel</button>`);
  } else {
    buttons.push(`<a class="btn sm ghost" href="#/preview/${esc(job.id)}">Open</a>`);
    if (job.status === 'failed') buttons.push(`<button class="btn sm soft" data-act="retry" data-id="${esc(job.id)}">${icons.retry}</button>`);
    if (job.status === 'printed' || job.status === 'canceled') buttons.push(`<button class="btn sm soft" data-act="print" data-id="${esc(job.id)}">${icons.play}</button>`);
    buttons.push(`<button class="btn sm ghost" data-act="delete" data-id="${esc(job.id)}">${icons.trash}</button>`);
  }
  return buttons.join('');
}

async function paintOutbox(container) {
  const host = container.querySelector('#q-outbox-card');
  if (!host) return;
  const printer = store.state.printer;
  if (!printer || printer.active.id !== 'outbox') { host.classList.add('hidden'); return; }
  host.classList.remove('hidden');

  try {
    const { files, dir } = await api.outbox();
    host.innerHTML = `
      <div class="card-head">
        <h3>${icon('folder')} Outbox</h3>
        <span class="muted small">${esc(dir)}</span>
      </div>
      ${files.length ? `<div class="stack">${files.slice(0, 6).map(f => `
          <div class="row" style="gap:10px">
            <div class="grow truncate small mono">${esc(f.name)}</div>
            <span class="muted small">${fmtAgo(f.at)}</span>
            <a class="btn sm ghost" href="${api.outboxUrl(f.name)}" target="_blank" rel="noopener">${icons.download}</a>
          </div>`).join('')}</div>`
        : '<div class="muted small">Nothing saved yet.</div>'}
      <div style="margin-top:12px" class="small muted">Print-ready PDFs land here while no printer is connected.</div>`;
  } catch {
    host.classList.add('hidden');
  }
}
