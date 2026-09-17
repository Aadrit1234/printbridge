/* Home view — get a document into the pipeline. */

import { api, adminUrl } from '../api.js';
import { store } from '../store.js';
import {
  esc, icon, icons, toast, progressBar, jobRow,
  fmtBytes, emptyState, note, ACTIVE_STATUSES,
} from '../ui.js';

const SUGGESTED = ['A4', 'Letter', 'PDF', 'JPG', 'PNG', 'HEIC', 'TXT', 'DOCX'];

let local = { uploading: false, percent: 0, label: '', error: '' };

export async function render(container, _params, ctx) {
  container.innerHTML = shell();
  bind(container, ctx);
  paintPrinterCard(container);
  paintRecent(container);
  return { update: () => { paintPrinterCard(container); paintRecent(container); } };
}

function shell() {
  return `
  <section class="view">
    <div class="view-head">
      <h1>Print something</h1>
      <p>Upload from this device — the preview shows exactly what the printer will output.</p>
    </div>

    <div class="card" id="printer-card"></div>

    <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Choose files to print">
      <input type="file" id="file-input" multiple hidden
             accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.gif,.bmp,.tif,.tiff,.txt,.csv,.log,.md,.doc,.docx,.odt,.rtf,.ppt,.pptx,.xls,.xlsx,.ods">
      <input type="file" id="photo-input" accept="image/*" capture="environment" hidden>
      <div class="dropzone-inner">
        <div class="dropzone-icon">${icons.upload}</div>
        <h2>Drop files here</h2>
        <p>Or tap to browse. Photos, PDFs, text files and Office documents all work — up to 12 at once.</p>
        <div class="row" style="justify-content:center;flex-wrap:wrap">
          <button class="btn primary" id="browse-btn">${icons.folder}<span>Choose files</span></button>
          <button class="btn" id="photo-btn">${icons.camera}<span>Take a photo</span></button>
        </div>
        <div class="type-chips">
          ${SUGGESTED.map(t => `<span class="chip kind">${esc(t)}</span>`).join('')}
        </div>
        <p class="small muted">Tip: you can paste a screenshot or file with Ctrl / ${icon('command', 'kbd-icon')} + V</p>
      </div>
    </div>

    <div class="card hidden" id="upload-card">
      <div class="spread" style="margin-bottom:8px">
        <strong id="upload-label">Uploading…</strong>
        <span class="muted small" id="upload-percent">0%</span>
      </div>
      ${progressBar(0, 'upload-progress')}
    </div>

    <div class="card hidden" id="upload-error"></div>

    <div class="card">
      <div class="card-head">
        <h3>${icon('queue')} Recent activity</h3>
        <a class="btn sm ghost" href="#/mine">My prints</a>
      </div>
      <div id="recent-list"></div>
    </div>
  </section>`;
}

/* ---------------- printer summary ---------------- */

function paintPrinterCard(container) {
  const host = container.querySelector('#printer-card');
  if (!host) return;
  const printer = store.state.printer;

  if (!printer) {
    host.innerHTML = `<div class="spread"><div class="muted small">Checking the printer…</div></div>`;
    return;
  }

  const status = printer.state.status;
  const meta = {
    ready: { cls: 'printed', text: 'Ready' },
    busy: { cls: 'printing', text: 'Printing' },
    unconfigured: { cls: 'queued', text: 'Not selected' },
    offline: { cls: 'failed', text: 'Offline' },
    error: { cls: 'failed', text: 'Problem' },
    unknown: { cls: 'canceled', text: 'Unknown' },
  }[status] || { cls: 'canceled', text: status };

  const kindIcon = printer.active.kind === 'usb' ? icons.usb : printer.active.kind === 'network' ? icons.wifi : icons.folder;
  const outbox = printer.active.id === 'outbox';

  host.innerHTML = `
    <div class="spread wrap">
      <div class="row">
        <div class="row" style="gap:10px">
          <div class="empty-icon" style="width:44px;height:44px;margin:0;border-radius:14px">${kindIcon}</div>
          <div>
            <div class="row" style="gap:8px">
              <strong>${esc(printer.state.name || printer.active.label)}</strong>
              <span class="chip ${meta.cls}">${esc(meta.text)}</span>
            </div>
            <div class="muted small">${esc(printer.active.label)}${printer.state.queueDepth ? ` · ${printer.state.queueDepth} job(s) waiting` : ''}</div>
          </div>
        </div>
      </div>
      <a class="btn sm" href="${esc(adminUrl())}" data-admin-link>${icons.wrench}<span>Printer setup</span></a>
    </div>
    ${outbox ? `<div style="margin-top:12px">${note(`No printer is connected yet, so finished jobs are saved to the <b>outbox</b> folder. The owner can pick the USB queue in <a href="${esc(adminUrl())}" data-admin-link><b>Admin</b></a>.`, 'warn')}</div>` : ''}
  `;
}

/* ---------------- recent jobs ---------------- */

function paintRecent(container) {
  const host = container.querySelector('#recent-list');
  if (!host) return;
  const jobs = store.jobList().slice(0, 5);
  if (!jobs.length) {
    host.innerHTML = emptyState({
      iconName: 'upload',
      title: 'Nothing printed yet',
      text: 'Upload a document and it will show up here with its status.',
    });
    return;
  }

  host.innerHTML = `<div class="job-list">${jobs.map(j => jobRow(j, { actions: actionsFor(j) })).join('')}</div>`;
  bindRowActions(host);
}

function actionsFor(job) {
  if (ACTIVE_STATUSES.includes(job.status)) {
    return `<button class="btn sm ghost" data-act="cancel" data-id="${esc(job.id)}">Cancel</button>`;
  }
  const preview = `<a class="btn sm ghost" href="#/preview/${esc(job.id)}">Open</a>`;
  if (job.status === 'failed') return `${preview}<button class="btn sm soft" data-act="retry" data-id="${esc(job.id)}">Retry</button>`;
  if (job.status === 'printed') return `${preview}<button class="btn sm soft" data-act="print" data-id="${esc(job.id)}">Print again</button>`;
  return `${preview}<button class="btn sm primary" data-act="print" data-id="${esc(job.id)}">Print</button>`;
}

function bindRowActions(host) {
  host.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      const { act, id } = btn.dataset;
      btn.disabled = true;
      try {
        if (act === 'print') { await api.print(id, {}); toast('Sent to the printer', 'Watch the queue for live status'); }
        if (act === 'retry') { await api.retry(id); toast('Job queued again'); }
        if (act === 'cancel') { await api.cancel(id); toast('Job canceled'); }
      } catch (e) {
        toast('Action failed', e.message, 'err');
      } finally {
        btn.disabled = false;
      }
    });
  });
}

/* ---------------- upload ---------------- */

function bind(container, ctx) {
  const dropzone = container.querySelector('#dropzone');
  const fileInput = container.querySelector('#file-input');
  const photoInput = container.querySelector('#photo-input');
  const uploadCard = container.querySelector('#upload-card');
  const errorCard = container.querySelector('#upload-error');

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
    if (files.length) runUpload(files, { container, uploadCard, errorCard }, ctx);
  });

  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    if (files.length) runUpload(files, { container, uploadCard, errorCard }, ctx);
    fileInput.value = '';
  });
  photoInput.addEventListener('change', () => {
    const files = [...photoInput.files];
    if (files.length) runUpload(files, { container, uploadCard, errorCard }, ctx);
    photoInput.value = '';
  });

  // paste images/files straight from the clipboard
  const onPaste = (event) => {
    const items = [...(event.clipboardData?.items || [])];
    const files = items.map(i => (i.kind === 'file' ? i.getAsFile() : null)).filter(Boolean);
    if (files.length) {
      files.forEach((f, i) => { if (!f.name) files[i] = new File([f], `pasted-${Date.now()}.png`, { type: f.type }); });
      runUpload(files, { container, uploadCard, errorCard }, ctx);
    }
  };
  window.addEventListener('paste', onPaste);

  container._cleanup = () => window.removeEventListener('paste', onPaste);
}

async function runUpload(files, { container, uploadCard, errorCard }, ctx) {
  if (local.uploading) return;
  local.uploading = true;
  errorCard.classList.add('hidden');
  uploadCard.classList.remove('hidden');

  const label = container.querySelector('#upload-label');
  const percent = container.querySelector('#upload-percent');
  const bar = container.querySelector('.upload-progress > i');

  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
  label.textContent = files.length === 1
    ? `Uploading ${files[0].name} (${fmtBytes(files[0].size)})`
    : `Uploading ${files.length} files (${fmtBytes(totalBytes)})`;

  try {
    const result = await api.upload(files, {
      onProgress: (p) => {
        const pct = Math.round(p * 78);
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
      'Preparing the print preview…',
      'ok'
    );
    ctx.navigate(`#/preview/${result.jobs[0].id}`);
  } catch (e) {
    errorCard.classList.remove('hidden');
    errorCard.innerHTML = `${icons.alert}<div><strong>Upload failed</strong><div class="muted small" style="margin-top:4px">${esc(e.message)}</div></div>`;
    errorCard.style.display = 'flex';
    toast('Upload failed', e.message, 'err');
  } finally {
    local.uploading = false;
    setTimeout(() => uploadCard.classList.add('hidden'), 500);
  }
}

export function destroy(container) {
  container._cleanup?.();
}
