/* My prints — everything this device sent, with the code each print command got.
 *
 * Only this browser's jobs are ever shown; the server keeps everybody's queues
 * apart by device, so there is nothing here to filter or hide.
 */

import { api } from '../api.js';
import { store } from '../store.js';
import { savedCodes } from '../prefs.js';
import {
  esc, icon, icons, toast, jobRow, confirmDialog, emptyState, ACTIVE_STATUSES, fmtAgo,
} from '../ui.js';

export async function render(container, _params, ctx) {
  container.innerHTML = shell();
  bind(container, ctx);
  paint(container, ctx);

  // The live stream carries this device's jobs; one fetch closes the gap
  // between the page opening and the first event arriving.
  api.jobs(100).then((res) => {
    for (const job of res.jobs) store.upsertJob(job);
    paint(container, ctx);
  }).catch(() => { /* offline — show what the store knows */ });

  return {
    update(type) {
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
        <p>Documents sent from this device, and the code every print command got.</p>
      </div>
      <div class="row">
        <span class="chip" id="m-connection">connecting</span>
        <a class="btn sm" href="#/print">${icons.upload}<span>Print something</span></a>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>${icon('command')} Find a print by its code</h3></div>
      <form class="code-finder" id="m-find">
        <div class="field grow">
          <label for="m-code">Print code</label>
          <input class="input" id="m-code" placeholder="PB-XXXX-XXXX" autocomplete="off" spellcheck="false" maxlength="16">
        </div>
        <button class="btn primary" type="submit">${icons.scan}<span>Look it up</span></button>
      </form>
      <div class="row wrap" id="m-recent-codes" style="margin-top:12px;gap:8px"></div>
    </div>

    <div class="card hidden" id="m-active-card">
      <div class="card-head"><h3>${icon('printer')} In progress</h3></div>
      <div id="m-active"></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>${icon('list')} History</h3>
        <span class="grow"></span>
        <span class="small muted" id="m-count"></span>
      </div>
      <div id="m-list"></div>
    </div>
  </section>`;
}

function bind(container, ctx) {
  container.querySelector('#m-find').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = container.querySelector('#m-code').value.trim();
    if (!value) return;
    ctx.navigate(`#/code/${encodeURIComponent(value)}`);
  });

  container.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act], a[data-open]');
    if (!button) return;
    const id = button.dataset.id;
    const job = store.state.jobs.get(id);
    if (!job) return;

    if (button.dataset.open) return; // handled by hash link

    if (button.dataset.act === 'print') {
      button.disabled = true;
      try {
        const updated = await api.print(id, {});
        store.upsertJob(updated);
        toast('Print command sent', updated.token ? `New code ${updated.token}` : '', 'ok', 6000);
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
        toast('Print stopped', '', 'info');
      } catch (e) {
        toast('Could not stop it', e.message, 'err');
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
        store.emit('jobDeleted', id);
        toast('Deleted');
        paint(container, ctx);
      } catch (e) {
        toast('Could not delete', e.message, 'err');
      }
    }
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

  // quick chips for codes this browser has seen
  const codes = savedCodes().slice(0, 6);
  const chips = container.querySelector('#m-recent-codes');
  if (chips) {
    chips.innerHTML = codes.length
      ? `<span class="small muted">Recent codes:</span>${codes.map(c => `<a class="code-inline" href="#/code/${encodeURIComponent(c)}">${esc(c)}</a>`).join('')}`
      : '';
  }

  const activeCard = container.querySelector('#m-active-card');
  activeCard.hidden = active.length === 0;
  container.querySelector('#m-active').innerHTML = active.map(j => jobRow(j, {
    actions: `<button class="btn sm ghost" data-act="cancel" data-id="${esc(j.id)}">${icons.x}<span>Stop</span></button>`,
  })).join('');

  const count = container.querySelector('#m-count');
  if (count) count.textContent = done.length ? `${done.length} item${done.length === 1 ? '' : 's'}` : '';

  const list = container.querySelector('#m-list');
  if (!done.length) {
    list.innerHTML = emptyState({
      iconName: 'printer',
      title: 'Nothing printed yet',
      text: 'Upload a document and it will show up here with its code and status.',
      action: '<a class="btn primary" href="#/print">Choose a file</a>',
    });
    return;
  }

  list.innerHTML = `<div class="job-list reveal">${done.map((job) => {
    const actions = [
      job.hasPdf && job.status !== 'failed'
        ? `<button class="btn sm soft" data-act="print" data-id="${esc(job.id)}">${icons.play}<span>Print again</span></button>`
        : '',
      `<a class="btn sm ghost" href="#/job/${esc(job.id)}" data-id="${esc(job.id)}">${icons.scan}<span>Preview</span></a>`,
      `<button class="btn sm ghost" data-act="delete" data-id="${esc(job.id)}">${icons.trash}</button>`,
    ].filter(Boolean).join('');
    return jobRow(job, { actions, extra: job.updatedAt && !ACTIVE_STATUSES.includes(job.status) ? `<span>${esc(fmtAgo(job.updatedAt))}</span>` : '' });
  }).join('')}</div>`;
}
