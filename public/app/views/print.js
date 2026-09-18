/* Home — get a document in, and choose the printer it goes to.
 *
 * Three things live here, in the order a person needs them: the drop zone, the
 * printer picker, and the last few prints with their codes. Nothing about the
 * server, the queue or the control room is shown; the printer picker is the
 * only "configuration" the person printing ever sees.
 */

import { api } from '../api.js';
import { store, refreshPrinters } from '../store.js';
import { chosenPrinter, setChosenPrinter } from '../prefs.js';
import {
  esc, icon, icons, toast, fmtBytes, emptyState, note,
  statusChip, printCode, tokenOf, ACTIVE_STATUSES, fmtAgo,
} from '../ui.js';

const SUGGESTED = ['PDF', 'JPG', 'PNG', 'HEIC', 'TXT', 'DOCX', 'A4', 'Letter'];

let local = { uploading: false, files: [] };

export async function render(container, _params, ctx) {
  container.innerHTML = shell();
  bind(container, ctx);
  paintPrinters(container);
  paintRecent(container);
  return {
    update(type) {
      if (['printer', 'connection', 'hello', 'boot', 'resync', 'printers'].includes(type)) paintPrinters(container);
      if (['job', 'jobDeleted', 'hello', 'boot', 'resync'].includes(type)) paintRecent(container);
    },
    destroy() { container._cleanup?.(); },
  };
}

function shell() {
  return `
  <section class="view">
    <div class="view-head">
      <h1>Print something</h1>
      <p>Drop a file in, pick the printer, check the preview — then send it and keep the code it gives you.</p>
    </div>

    <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Choose files to print">
      <input type="file" id="file-input" multiple hidden
             accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.gif,.bmp,.tif,.tiff,.txt,.csv,.log,.md,.doc,.docx,.odt,.rtf,.ppt,.pptx,.xls,.xlsx,.ods">
      <input type="file" id="photo-input" accept="image/*" capture="environment" hidden>
      <div class="dropzone-inner">
        <div class="dropzone-icon">${icons.upload}</div>
        <h2>Drop files here</h2>
        <p>Or tap to browse. Photos, PDFs, text and Office documents — up to 12 at once.</p>
        <div class="row wrap" style="justify-content:center">
          <button class="btn primary" id="browse-btn" type="button">${icons.folder}<span>Choose files</span></button>
          <button class="btn" id="photo-btn" type="button">${icons.camera}<span>Take a photo</span></button>
        </div>
        <div class="type-chips">
          ${SUGGESTED.map(t => `<span class="chip kind">${esc(t)}</span>`).join('')}
        </div>
        <p class="small muted">Tip: you can paste a screenshot with ${icon('command', 'kbd-icon')} + V</p>
      </div>
    </div>

    <div class="card hidden" id="upload-card">
      <div class="spread" style="margin-bottom:10px">
        <strong id="upload-label">Uploading…</strong>
        <span class="muted small" id="upload-percent">0%</span>
      </div>
      <div class="progress" id="upload-progress"><i style="width:0%"></i></div>
      <div class="small muted" id="upload-note" style="margin-top:8px">Preparing the preview…</div>
    </div>

    <div class="card hidden" id="upload-error" style="align-items:flex-start;gap:10px"></div>

    <div class="card" id="printer-card">
      <div class="card-head">
        <h3>${icon('printer')} Where should it print?</h3>
        <span class="grow"></span>
        <button class="btn sm ghost" id="printer-refresh">${icons.refresh}<span>Check again</span></button>
      </div>
      <div id="printer-list"></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>${icon('queue')} Recent prints</h3>
        <span class="grow"></span>
        <a class="btn sm ghost" href="#/history">${icons.list}<span>All my prints</span></a>
      </div>
      <div id="recent-list"></div>
    </div>
  </section>`;
}

/* ---------------- printer picker ---------------- */

function paintPrinters(container) {
  const host = container.querySelector('#printer-list');
  if (!host) return;

  const printers = store.printerList();
  const selected = store.preferredPrinter();

  if (!printers.length) {
    host.innerHTML = window.navigator.onLine
      ? `${note('Looking for printers…', 'info')}`
      : `${note('The print server is unreachable right now. Files you add will be kept for later.', 'warn')}`;
    return;
  }

  const onlyOutbox = printers.length === 1 && printers[0].kind === 'outbox';
  const icoFor = (p) => (p.kind === 'usb' ? icons.usb : p.kind === 'network' ? icons.wifi : p.kind === 'local' ? icons.printer : icons.folder);
  const statusMeta = {
    ready: { cls: 'printed', text: 'ready' },
    busy: { cls: 'printing', text: 'printing now' },
    error: { cls: 'failed', text: 'needs attention' },
    offline: { cls: 'failed', text: 'offline' },
    unknown: { cls: 'canceled', text: 'unknown' },
    unconfigured: { cls: 'queued', text: 'not set up' },
  };

  host.innerHTML = `
    <div class="pick-list reveal">
      ${printers.map((p) => {
        const meta = statusMeta[p.status] || { cls: 'canceled', text: p.status || 'unknown' };
        const isDefault = store.state.defaultPrinter === p.id;
        return `
        <button class="pick ${p.id === selected ? 'selected' : ''}" data-printer="${esc(p.id)}" type="button">
          <span class="pick-ico">${icoFor(p)}</span>
          <span class="pick-main">
            <span class="pick-name">
              ${esc(p.name)}
              ${isDefault ? '<span class="chip live">default</span>' : ''}
            </span>
            <span class="pick-sub">${esc(p.detail || '')}</span>
          </span>
          <span class="chip ${meta.cls}">${esc(meta.text)}</span>
        </button>`;
      }).join('')}
    </div>
    ${onlyOutbox ? `<div style="margin-top:12px">${note('No printer is connected to this server yet, so prints are saved as ready-to-print files instead of coming out on paper.', 'warn')}</div>` : ''}`;

  host.querySelectorAll('[data-printer]').forEach(btn => {
    btn.addEventListener('click', () => {
      setChosenPrinter(btn.dataset.printer);
      paintPrinters(container);
      toast('Printer selected', btn.querySelector('.pick-name')?.textContent.trim() || '', 'ok', 1800);
    });
  });
}

/* ---------------- recent ---------------- */

function paintRecent(container) {
  const host = container.querySelector('#recent-list');
  if (!host) return;
  const jobs = store.jobList().slice(0, 3);

  if (!jobs.length) {
    host.innerHTML = emptyState({
      iconName: 'upload',
      title: 'Nothing yet',
      text: 'Your prints show up here with their code and status.',
    });
    return;
  }

  host.innerHTML = `<div class="job-list reveal">${jobs.map(job => miniRow(job)).join('')}</div>`;
  host.querySelectorAll('[data-open]').forEach(el => {
    el.addEventListener('click', () => { location.hash = `#/job/${el.dataset.open}`; });
  });
}

function miniRow(job) {
  const code = tokenOf(job);
  const active = ACTIVE_STATUSES.includes(job.status);
  return `
    <button class="job-row hoverable" data-open="${esc(job.id)}" type="button" style="text-align:left">
      <span class="job-thumb">${icons.file}</span>
      <span class="job-info">
        <span class="job-title"><span class="job-name truncate">${esc(job.name)}</span></span>
        <span class="job-meta">
          <span>${job.pageCount ? `${job.pageCount} page${job.pageCount === 1 ? '' : 's'}` : 'preparing'}</span>
          <span>${esc(fmtAgo(job.createdAt))}</span>
        </span>
        ${code ? `<span class="row" style="gap:8px">${printCode(code)}</span>` : ''}
      </span>
      <span class="job-side">${statusChip(job.status)}${active ? `<span class="small muted">${esc(job.phase || '')}</span>` : ''}</span>
    </button>`;
}

/* ---------------- upload ---------------- */

function bind(container, ctx) {
  const dropzone = container.querySelector('#dropzone');
  const fileInput = container.querySelector('#file-input');
  const photoInput = container.querySelector('#photo-input');

  const openPicker = () => fileInput.click();
  container.querySelector('#browse-btn').addEventListener('click', (e) => { e.stopPropagation(); openPicker(); });
  container.querySelector('#photo-btn').addEventListener('click', (e) => { e.stopPropagation(); photoInput.click(); });
  dropzone.addEventListener('click', openPicker);
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
  });

  ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
  }));
  dropzone.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) runUpload(files, container, ctx);
  });

  container.querySelector('#printer-refresh').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    await refreshPrinters();
    paintPrinters(container);
    btn.disabled = false;
    toast('Printer list refreshed', '', 'ok', 1600);
  });

  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    if (files.length) runUpload(files, container, ctx);
    fileInput.value = '';
  });
  photoInput.addEventListener('change', () => {
    const files = [...photoInput.files];
    if (files.length) runUpload(files, container, ctx);
    photoInput.value = '';
  });

  const onPaste = (event) => {
    const items = [...(event.clipboardData?.items || [])];
    const files = items.map(i => (i.kind === 'file' ? i.getAsFile() : null)).filter(Boolean);
    if (!files.length) return;
    files.forEach((f, i) => { if (!f.name) files[i] = new File([f], `pasted-${Date.now()}.png`, { type: f.type }); });
    runUpload(files, container, ctx);
  };
  window.addEventListener('paste', onPaste);
  container._cleanup = () => window.removeEventListener('paste', onPaste);
}

async function runUpload(files, container, ctx) {
  if (local.uploading) return;
  local.uploading = true;

  const card = container.querySelector('#upload-card');
  const errorCard = container.querySelector('#upload-error');
  const label = container.querySelector('#upload-label');
  const percent = container.querySelector('#upload-percent');
  const bar = container.querySelector('#upload-progress > i');

  errorCard.classList.add('hidden');
  card.classList.remove('hidden');

  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
  label.textContent = files.length === 1
    ? `Uploading ${files[0].name} (${fmtBytes(files[0].size)})`
    : `Uploading ${files.length} files (${fmtBytes(totalBytes)})`;

  try {
    const result = await api.upload(files, {
      onProgress: (p) => {
        const pct = Math.round(p * 80);
        percent.textContent = `${pct}%`;
        bar.style.width = `${pct}%`;
      },
    });

    percent.textContent = '100%';
    bar.style.width = '100%';
    for (const job of result.jobs) store.upsertJob(job);
    for (const err of result.errors || []) toast('Skipped a file', `${err.name}: ${err.error}`, 'err', 6000);
    if (!result.jobs.length) throw new Error('No files could be accepted');

    toast(
      result.jobs.length === 1 ? 'File added' : `${result.jobs.length} files added`,
      'Building the preview…',
      'ok', 2600,
    );
    ctx.navigate(`#/job/${result.jobs[0].id}`);
  } catch (e) {
    errorCard.classList.remove('hidden');
    errorCard.innerHTML = `${icons.alert}<div><strong>Upload failed</strong><div class="muted small" style="margin-top:4px">${esc(e.message)}</div></div>`;
    toast('Upload failed', e.message, 'err');
  } finally {
    local.uploading = false;
    setTimeout(() => card.classList.add('hidden'), 600);
  }
}
