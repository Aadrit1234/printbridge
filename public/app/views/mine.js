/* My prints — the jobs this browser sent, and nothing else.
 *
 * The guest side never shows other people's documents, the printer's internal
 * queue, or the server's history; that is the admin app's job. */

import { api } from '../api.js';
import { store } from '../store.js';
import {
  esc, icon, icons, toast, jobRow, confirmDialog, emptyState, ACTIVE_STATUSES, fmtAgo,
} from '../ui.js';

export async function render(container, _params, ctx) {
  container.innerHTML = shell();
  bind(container, ctx);
  // The stream already carries this device's jobs; one refresh covers the gap
  // between the page loading and the first event.
  api.jobs(100).then((res) => {
    for (const job of res.jobs) store.upsertJob(job);
    paint(container, ctx);
  }).catch(() => { /* offline — the store still has what it knows */ });

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
        <h1>My prints</h1>
        <p>Documents sent from this device. Updates appear live.</p>
      </div>
      <div class="row">
        <span class="chip" id="m-connection">connecting</span>
        <a class="btn sm" href="#/print">${icons.upload}<span>Print something</span></a>
      </div>
    </div>

    <div class="card" id="m-active-card" hidden>
      <div class="card-head">${icon('printer')}<h2>In progress</h2></div>
      <div id="m-active"></div>
    </div>

    <div class="card">
      <div class="card-head">${icon('list')}<h2>History</h2>
        <span class="grow"></span>
        <span class="small muted" id="m-count"></span>
      </div>
      <div id="m-list"></div>
    </div>
  </section>`;
}

function bind(container, ctx) {
  container.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const id = button.dataset.id;
    const job = store.state.jobs.get(id);
    if (!job) return;

    if (button.dataset.act === 'print') {
      button.disabled = true;
      try {
        await api.print(id, {});
        toast('Sent to the printer', 'Watch the status here');
      } catch (e) {
        toast('Could not print', e.message, 'err', 7000);
      }
      button.disabled = false;
      return;
    }

    if (button.dataset.act === 'cancel') {
      button.disabled = true;
      try {
        await api.cancel(id);
        toast('Canceled');
      } catch (e) {
        toast('Could not cancel', e.message, 'err');
      }
      button.disabled = false;
      return;
    }

    if (button.dataset.act === 'delete') {
      const ok = await confirmDialog({
        title: 'Delete this print?',
        message: `"${job.name}" and its preview will be removed.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.remove(id);
        store.state.jobs.delete(id);
        toast('Deleted');
        paint(container, ctx);
      } catch (e) {
        toast('Could not delete', e.message, 'err');
      }
      return;
    }

    if (button.dataset.act === 'open') ctx.navigate(`#/preview/${id}`);
  });
}

function paint(container, ctx) {
  const connection = container.querySelector('#m-connection');
  if (!connection) return;
  const live = store.state.connection === 'live';
  connection.className = `chip ${live ? 'live' : 'offline'}`;
  connection.textContent = live ? 'live' : store.state.connection === 'offline' ? 'server offline' : 'connecting';

  const jobs = store.jobList();
  const active = jobs.filter(j => ACTIVE_STATUSES.includes(j.status));
  const done = jobs.filter(j => !ACTIVE_STATUSES.includes(j.status));

  const activeCard = container.querySelector('#m-active-card');
  const activeHost = container.querySelector('#m-active');
  activeCard.hidden = active.length === 0;
  activeHost.innerHTML = active.map(j => jobRow(j, {
    actions: `<button class="btn sm ghost" data-act="cancel" data-id="${esc(j.id)}">${icons.x}<span>Cancel</span></button>`,
  })).join('');

  const count = container.querySelector('#m-count');
  if (count) count.textContent = done.length ? `${done.length} item${done.length === 1 ? '' : 's'}` : '';

  const list = container.querySelector('#m-list');
  if (!done.length) {
    list.innerHTML = emptyState({
      iconName: 'printer',
      title: 'Nothing printed yet',
      text: 'Upload a document and it will show up here with its status.',
      action: '<a class="btn primary" href="#/print">Choose a file</a>',
    });
    return;
  }

  list.innerHTML = done.map((job) => {
    const canPrint = job.hasPdf && job.status !== 'failed';
    const actions = [
      canPrint ? `<button class="btn sm soft" data-act="print" data-id="${esc(job.id)}">${icons.play}<span>Print again</span></button>` : '',
      `<button class="btn sm ghost" data-act="open" data-id="${esc(job.id)}">${icons.scan}<span>Preview</span></button>`,
      `<button class="btn sm ghost" data-act="delete" data-id="${esc(job.id)}">${icons.trash}</button>`,
    ].filter(Boolean).join('');
    return jobRow(job, { actions, showProgress: true });
  }).join('');
}
