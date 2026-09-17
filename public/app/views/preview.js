/* Preview view — see exactly what will print, then send it. */

import { api } from '../api.js';
import { store } from '../store.js';
import {
  esc, icon, icons, toast, progressBar, statusChip, statusMeta, jobThumb,
  fmtBytes, fmtAgo, confirmDialog, note, emptyState, ACTIVE_STATUSES, pageLabel,
} from '../ui.js';

const state = {
  id: null,
  page: 1,
  zoom: 1,
  fit: true,
  selected: new Set(),
  rangeMode: false,
  thumbLimit: 12,
  printing: false,
};

const ZOOMS = [0.5, 0.6, 0.75, 0.9, 1, 1.15, 1.35, 1.6, 2];

export async function render(container, params, ctx) {
  state.id = params.id;
  state.page = 1;
  state.zoom = 1;
  state.fit = true;
  state.selected.clear();
  state.rangeMode = false;

  const job = store.state.jobs.get(state.id) || await api.job(state.id).catch(() => null);
  if (!job) {
    container.innerHTML = `<div class="card">${emptyState({ iconName: 'alert', title: 'Job not found', text: 'It may have been removed from the history.', action: '<a class="btn" href="#/print">Back to print</a>' })}</div>`;
    return {};
  }
  store.upsertJob(job);

  container.innerHTML = shell(job);
  bindStage(container, job);
  bindOptions(container, job, ctx);
  renderThumbs(container, job);
  paintStatus(container, job);
  paintBatchRail(container, job, ctx);

  return {
    update(type, p) {
      const fresh = store.state.jobs.get(state.id);
      if (!fresh) return;
      if (type === 'job' && fresh.id === state.id) {
        const wasReady = job.status !== 'ready' && fresh.status === 'ready';
        Object.assign(job, fresh);
        paintStatus(container, fresh);
        if (wasReady || (fresh.renderedPages || 0) !== (job.renderedPages || 0)) {
          renderThumbs(container, fresh);
          paintStageCount(container, fresh);
          state.stageShow?.();
        }
      }
      if (['job', 'jobDeleted', 'hello', 'resync'].includes(type)) paintBatchRail(container, fresh, ctx);
      if (type === 'settings') paintSummary(container, fresh);
    },
  };
}

/* ---------------- markup ---------------- */

function shell(job) {
  return `
  <section class="view">
    <div class="view-head spread wrap">
      <div class="grow">
        <h1 class="truncate">${esc(job.name)}</h1>
        <p>
          <span id="pv-pages">${esc(pageLabel(job))}</span> ·
          <span>${esc(fmtBytes(job.size))}</span> ·
          <span>${esc(fmtAgo(job.createdAt))}</span>
        </p>
      </div>
      <div class="row">
        <a class="btn sm" href="#/print">${icons.upload}<span>Print more</span></a>
        <a class="btn sm" href="#/mine">${icons.queue}<span>My prints</span></a>
      </div>
    </div>

    <div class="card" id="pv-status"></div>

    <div class="preview-layout">
      <div class="stage">
        <div class="stage-toolbar">
          <button class="icon-btn" id="pv-prev" title="Previous page">${icons.chevronLeft}</button>
          <button class="icon-btn" id="pv-next" title="Next page">${icons.chevronRight}</button>
          <span class="chip" id="pv-page-chip">Page 1</span>
          <span class="grow"></span>
          <button class="icon-btn" id="pv-zoom-out" title="Zoom out">${icons.zoomOut}</button>
          <span class="zoom-value" id="pv-zoom">fit</span>
          <button class="icon-btn" id="pv-zoom-in" title="Zoom in">${icons.zoomIn}</button>
          <button class="btn sm ghost" id="pv-fit">Fit width</button>
          <button class="btn sm ghost" id="pv-select-pages">Select pages</button>
        </div>
        <div class="stage-canvas" id="pv-canvas">
          <div class="page-sheet" id="pv-sheet">
            <img id="pv-img" alt="Print preview" draggable="false">
            <span class="page-tag" id="pv-tag">1</span>
          </div>
        </div>
        <div class="thumbstrip" id="pv-thumbs"></div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head">
            <h3>${icon('printer')} Print settings</h3>
            <span class="chip" id="pv-backend-chip">auto</span>
          </div>
          <div class="options-grid">
            <div class="opt-block">
              <span class="opt-label">Copies</span>
              <div class="stepper">
                <button id="pv-copies-minus" aria-label="Fewer copies">${icons.minus}</button>
                <output id="pv-copies">1</output>
                <button id="pv-copies-plus" aria-label="More copies">${icons.plus}</button>
              </div>
            </div>
            <div class="opt-block">
              <span class="opt-label">Paper</span>
              <div class="segmented" id="pv-paper"></div>
            </div>
            <div class="opt-block">
              <span class="opt-label">Scaling</span>
              <div class="segmented" id="pv-scale">
                <button data-scale="fit">Fit to page</button>
                <button data-scale="actual">Actual size</button>
              </div>
            </div>
            <div class="opt-block">
              <span class="opt-label">Two-sided</span>
              <label class="switch">
                <input type="checkbox" id="pv-duplex">
                <span class="track"></span>
                <span class="switch-label" id="pv-duplex-label">Off</span>
              </label>
            </div>
            <div class="opt-block">
              <span class="opt-label">Pages <span class="muted small" id="pv-range-hint">all pages</span></span>
              <input class="input" id="pv-range" placeholder="e.g. 1-3, 5" spellcheck="false">
            </div>
          </div>
          <div class="summary-line" id="pv-summary" style="margin-top:14px"></div>
          <div class="row" style="margin-top:12px">
            <button class="btn primary lg grow" id="pv-print">${icons.printer}<span>Print now</span></button>
          </div>
          <div class="row" style="margin-top:10px;flex-wrap:wrap">
            <a class="btn sm ghost" href="${api.pdfUrl(job.id)}" target="_blank" rel="noopener">${icons.download}<span>Print-ready PDF</span></a>
            ${job.hasOriginal ? `<a class="btn sm ghost" href="${api.originalUrl(job.id)}">${icons.file}<span>Original</span></a>` : ''}
            <button class="btn sm ghost" id="pv-delete">${icons.trash}<span>Delete</span></button>
          </div>
        </div>

        <div class="card" id="pv-batch-card"></div>
      </div>
    </div>
  </section>`;
}

/* ---------------- status banner ---------------- */

function paintStatus(container, job) {
  const host = container.querySelector('#pv-status');
  if (!host) return;
  const meta = statusMeta(job.status);
  const active = ACTIVE_STATUSES.includes(job.status);

  let body = '';
  if (job.status === 'converting' || job.status === 'uploading') {
    body = `${progressBar(job.progress)}<div class="small muted" style="margin-top:6px">${esc(job.phase || meta.label)}…</div>`;
  } else if (job.status === 'queued' || job.status === 'printing' || job.status === 'waiting') {
    body = `${progressBar(job.progress)}<div class="small muted" style="margin-top:6px">${esc(job.phase || meta.label)}${job.message ? ' · ' + esc(job.message) : ''}</div>`
      + (job.status === 'waiting'
        ? `<div class="row" style="margin-top:10px"><button class="btn sm ghost" id="pv-cancel-wait">${icons.x}<span>Stop trying</span></button></div>`
        : '');
  } else if (job.status === 'printed') {
    body = note(`Printed ${fmtAgo(job.printedAt || job.updatedAt)}${job.backend ? ` via <b>${esc(job.backend)}</b>` : ''}${job.message ? ` · ${esc(job.message)}` : ''}`, 'ok');
  } else if (job.status === 'failed') {
    body = `${note(esc(job.error || 'Printing failed'), 'warn')}
      <div class="row" style="margin-top:10px"><button class="btn sm soft" id="pv-retry">${icons.retry}<span>Try again</span></button></div>`;
  } else if (job.status === 'ready') {
    body = `<div class="small muted">Ready — check the preview, then press <b>Print now</b>.</div>`;
  } else if (job.status === 'canceled') {
    body = note('This job was canceled.', 'info');
  }

  host.innerHTML = `
    <div class="spread wrap">
      <div class="row">
        <span class="chip ${meta.cls}">${esc(meta.label)}</span>
        ${active ? `<span class="chip live">sending</span>` : ''}
      </div>
      <span class="muted small">${esc(job.phase || '')}</span>
    </div>
    <div style="margin-top:10px">${body}</div>`;

  const retry = host.querySelector('#pv-retry');
  if (retry) {
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      try { await api.retry(job.id); toast('Queued again'); } catch (e) { toast('Retry failed', e.message, 'err'); }
      retry.disabled = false;
    });
  }

  const stop = host.querySelector('#pv-cancel-wait');
  if (stop) {
    stop.addEventListener('click', async () => {
      stop.disabled = true;
      try { await api.cancel(job.id); toast('Stopped trying', 'The job will not print'); } catch (e) { toast('Could not cancel', e.message, 'err'); }
      stop.disabled = false;
    });
  }
}

/* ---------------- page stage ---------------- */

function bindStage(container, job) {
  const canvas = container.querySelector('#pv-canvas');
  const sheet = container.querySelector('#pv-sheet');
  const img = container.querySelector('#pv-img');
  const tag = container.querySelector('#pv-tag');
  const chip = container.querySelector('#pv-page-chip');

  const show = (page) => {
    const limit = state.thumbLimit;
    if (job.pageCount && page > job.pageCount) return;
    state.page = page;
    // Only request the image once the server has a printable PDF; requesting
    // earlier would race the conversion and 404.
    if (job.hasPdf) img.src = api.previewUrl(job.id, page);
    else img.removeAttribute('src');
    sheet.classList.toggle('pending', !job.hasPdf);
    tag.textContent = String(page);
    chip.textContent = job.pageCount ? `Page ${page} / ${job.pageCount}` : `Page ${page}`;
    if (page > limit - 3) {
      state.thumbLimit = Math.min((job.pageCount || limit) + 6, (job.pageCount || limit));
      renderThumbs(container, job);
    }
  };

  const applyZoom = () => {
    const available = Math.max(220, canvas.clientWidth - 36);
    if (state.fit) {
      sheet.style.width = `${available}px`;
      sheet.style.maxWidth = `${available}px`;
      sheet.style.transform = 'none';
      container.querySelector('#pv-zoom').textContent = 'fit';
    } else {
      sheet.style.width = `${available}px`;
      sheet.style.maxWidth = `${available}px`;
      sheet.style.transform = `scale(${state.zoom})`;
      sheet.style.transformOrigin = 'top center';
      container.querySelector('#pv-zoom').textContent = `${Math.round(state.zoom * 100)}%`;
    }
  };

  container.querySelector('#pv-prev').addEventListener('click', () => show(state.page - 1));
  container.querySelector('#pv-next').addEventListener('click', () => show(state.page + 1));
  container.querySelector('#pv-zoom-in').addEventListener('click', () => {
    const idx = ZOOMS.findIndex(z => z > state.zoom + 0.001);
    state.fit = false;
    state.zoom = ZOOMS[idx === -1 ? ZOOMS.length - 1 : idx];
    applyZoom();
  });
  container.querySelector('#pv-zoom-out').addEventListener('click', () => {
    const idx = [...ZOOMS].reverse().findIndex(z => z < state.zoom - 0.001);
    state.fit = false;
    state.zoom = ZOOMS[idx === -1 ? 0 : ZOOMS.length - 1 - idx];
    applyZoom();
  });
  container.querySelector('#pv-fit').addEventListener('click', () => { state.fit = true; applyZoom(); });
  container.querySelector('#pv-select-pages').addEventListener('click', (e) => {
    state.rangeMode = !state.rangeMode;
    e.currentTarget.classList.toggle('soft', state.rangeMode);
    toast(state.rangeMode ? 'Tap thumbnails to pick pages' : 'Page selection off', '', 'info', 2200);
    renderThumbs(container, job);
  });

  img.addEventListener('error', () => { toast('Preview unavailable for this page', 'You can still print', 'err', 3000); });

  // keyboard navigation
  const onKey = (event) => {
    if (event.target.matches('input, textarea')) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') show(state.page + 1);
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') show(state.page - 1);
  };
  window.addEventListener('keydown', onKey);
  container._cleanup = () => window.removeEventListener('keydown', onKey);

  state.stageShow = () => { show(state.page); applyZoom(); };
  show(1);
  applyZoom();
  window.addEventListener('resize', applyZoom);
}

function paintStageCount(container, job) {
  const el = container.querySelector('#pv-pages');
  if (el) el.textContent = pageLabel(job);
}

function renderThumbs(container, job) {
  const host = container.querySelector('#pv-thumbs');
  if (!host) return;

  if (!job.hasPdf) {
    host.innerHTML = Array.from({ length: 3 }, () => '<div class="thumb skeleton"></div>').join('');
    return;
  }

  const total = Math.min(job.pageCount || 1, state.thumbLimit, store.state.settings?.maxPreviewPages || 40);
  const items = [];
  for (let page = 1; page <= total; page++) {
    const selected = state.selected.has(page);
    items.push(`
      <button class="thumb ${page === state.page ? 'active' : ''} ${selected ? 'selected' : ''}" data-page="${page}">
        <img src="${api.previewUrl(job.id, page)}" alt="Page ${page}" loading="lazy">
        <span>${page}</span>
      </button>`);
  }
  if (job.pageCount && job.pageCount > total) items.push(`<div class="thumb skeleton" title="Rendering more pages"></div>`);
  host.innerHTML = items.join('');

  host.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = Number(btn.dataset.page);
      if (state.rangeMode) {
        state.selected.has(page) ? state.selected.delete(page) : state.selected.add(page);
        applySelection(container);
        renderThumbs(container, job);
      } else {
        const canvas = container.querySelector('#pv-canvas');
        state.page = page;
        const img = container.querySelector('#pv-img');
        img.src = api.previewUrl(job.id, page);
        container.querySelector('#pv-tag').textContent = String(page);
        container.querySelector('#pv-page-chip').textContent = job.pageCount ? `Page ${page} / ${job.pageCount}` : `Page ${page}`;
        host.querySelectorAll('.thumb').forEach(t => t.classList.toggle('active', Number(t.dataset.page) === page));
        canvas.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
  });
}

function applySelection(container) {
  const input = container.querySelector('#pv-range');
  const hint = container.querySelector('#pv-range-hint');
  const pages = [...state.selected].sort((a, b) => a - b);
  input.value = compressRanges(pages);
  hint.textContent = pages.length ? `${pages.length} page(s)` : 'all pages';
  paintSummary(container, store.state.jobs.get(state.id));
}

function compressRanges(pages) {
  if (!pages.length) return '';
  const out = [];
  let start = pages[0];
  let prev = pages[0];
  for (let i = 1; i <= pages.length; i++) {
    const current = pages[i];
    if (current !== prev + 1) {
      out.push(start === prev ? String(start) : `${start}-${prev}`);
      start = current;
    }
    prev = current;
  }
  return out.join(', ');
}

/* ---------------- options ---------------- */

function bindOptions(container, job, ctx) {
  const settings = store.state.settings || {};
  const papers = settings.papers || {};
  const paperHost = container.querySelector('#pv-paper');
  const currentPaper = job.options?.paper || settings.paper || 'a4';
  paperHost.innerHTML = Object.entries(papers).map(([key, def]) => `
    <button data-paper="${esc(key)}" class="${key === currentPaper ? 'active' : ''}">${esc(def.label)}</button>`).join('');
  paperHost.querySelectorAll('[data-paper]').forEach(btn => {
    btn.addEventListener('click', () => {
      paperHost.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      paintSummary(container, job);
    });
  });

  const copiesOut = container.querySelector('#pv-copies');
  copiesOut.textContent = String(job.options?.copies || settings.copies || 1);
  const step = (delta) => {
    const next = Math.max(1, Math.min(50, Number(copiesOut.textContent) + delta));
    copiesOut.textContent = String(next);
    paintSummary(container, job);
  };
  container.querySelector('#pv-copies-minus').addEventListener('click', () => step(-1));
  container.querySelector('#pv-copies-plus').addEventListener('click', () => step(1));

  const duplex = container.querySelector('#pv-duplex');
  const duplexLabel = container.querySelector('#pv-duplex-label');
  duplex.checked = Boolean(job.options?.duplex ?? settings.duplex);
  duplexLabel.textContent = duplex.checked ? 'On' : 'Off';
  duplex.addEventListener('change', () => {
    duplexLabel.textContent = duplex.checked ? 'On' : 'Off';
    paintSummary(container, job);
  });

  const scaleHost = container.querySelector('#pv-scale');
  const currentScale = job.options?.scale || settings.scale || 'fit';
  scaleHost.querySelectorAll('[data-scale]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.scale === currentScale);
    btn.addEventListener('click', () => {
      scaleHost.querySelectorAll('[data-scale]').forEach(b => b.classList.toggle('active', b === btn));
      paintSummary(container, job);
    });
  });

  const range = container.querySelector('#pv-range');
  range.value = job.options?.range || '';
  range.addEventListener('input', () => {
    state.selected.clear();
    const hint = container.querySelector('#pv-range-hint');
    hint.textContent = range.value.trim() ? 'custom range' : 'all pages';
    paintSummary(container, job);
  });

  container.querySelector('#pv-print').addEventListener('click', () => printNow(container, job, ctx));
  container.querySelector('#pv-delete').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete this job?',
      message: 'The uploaded file and its preview will be removed from the server.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.remove(job.id);
      toast('Job deleted');
      ctx.navigate('#/mine');
    } catch (e) {
      toast('Could not delete', e.message, 'err');
    }
  });

  const backendChip = container.querySelector('#pv-backend-chip');
  const printer = store.state.printer;
  if (backendChip && printer) backendChip.textContent = printer.active.id;

  paintSummary(container, job);
}

function readOptions(container) {
  const paper = container.querySelector('#pv-paper button.active')?.dataset.paper;
  const scale = container.querySelector('#pv-scale button.active')?.dataset.scale || 'fit';
  return {
    copies: Number(container.querySelector('#pv-copies').textContent) || 1,
    paper,
    scale,
    duplex: container.querySelector('#pv-duplex').checked,
    range: container.querySelector('#pv-range').value.trim(),
  };
}

function paintSummary(container, job) {
  const host = container.querySelector('#pv-summary');
  if (!host || !job) return;
  const opts = readOptions(container);
  const papers = store.state.settings?.papers || {};
  const paperLabel = papers[opts.paper]?.label || 'A4';
  const pages = opts.range ? opts.range : (job.pageCount ? `all ${job.pageCount}` : 'all');
  const sheetCount = opts.range && job.pageCount
    ? countPages(opts.range, job.pageCount)
    : (job.pageCount || 1);
  const sheets = sheetsFor(sheetCount, opts.duplex);

  host.innerHTML = [
    `<span class="chip">${esc(paperLabel)}</span>`,
    `<span class="chip">${opts.copies} × copy</span>`,
    `<span class="chip">${esc(pages)} pages</span>`,
    `<span class="chip">${opts.duplex ? '2-sided' : '1-sided'}</span>`,
    `<span class="chip">${esc(opts.scale === 'actual' ? 'actual size' : 'fit to page')}</span>`,
    `<span class="chip">≈ ${sheets * opts.copies} sheet${sheets * opts.copies === 1 ? '' : 's'}</span>`,
  ].join('');
}

function countPages(range, total) {
  let count = 0;
  for (const part of String(range).split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a >= 1 && b <= total) count += Math.abs(b - a) + 1;
  }
  return count || total;
}

function sheetsFor(pages, duplex) {
  return duplex ? Math.ceil(pages / 2) : pages;
}

async function printNow(container, job, ctx) {
  if (state.printing) return;
  const button = container.querySelector('#pv-print');
  state.printing = true;
  button.disabled = true;
  button.classList.add('spin');

  try {
    const options = readOptions(container);
    await api.print(job.id, options);
    toast('Sent to the printer', job.pageCount ? `${job.pageCount} page(s) queued` : 'Job queued', 'ok');
    if (store.state.settings?.autoOpenQueue) ctx.navigate('#/mine');
  } catch (e) {
    toast('Could not print', e.message, 'err', 6000);
  } finally {
    state.printing = false;
    button.classList.remove('spin');
    button.disabled = false;
  }
}

/* ---------------- batch rail ---------------- */

function paintBatchRail(container, job, ctx) {
  const host = container.querySelector('#pv-batch-card');
  if (!host) return;
  const batch = job.batchId ? store.jobsByBatch(job.batchId) : [job];

  if (batch.length <= 1) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }
  host.classList.remove('hidden');

  const ready = batch.filter(j => j.status === 'ready' || j.status === 'failed' || j.status === 'printed');
  host.innerHTML = `
    <div class="card-head">
      <h3>${icon('list')} Batch (${batch.length})</h3>
      <button class="btn sm soft" id="pv-print-all" ${ready.length ? '' : 'disabled'}>${icons.play}<span>Print all</span></button>
    </div>
    <div class="stack">
      ${batch.map(j => `
        <div class="row" style="gap:10px" data-batch="${esc(j.id)}">
          <div class="row grow" style="gap:9px;min-width:0;cursor:pointer">
            ${jobThumb(j)}
            <div class="grow" style="min-width:0">
              <div class="truncate small" style="font-weight:600">${esc(j.name)}</div>
              <div class="muted small">${esc(pageLabel(j))} ${j.id === state.id ? '· viewing' : ''}</div>
            </div>
          </div>
          <span class="chip ${statusMeta(j.status).cls}">${esc(statusMeta(j.status).label)}</span>
          <button class="btn sm ghost" data-batch-print="${esc(j.id)}" ${j.hasPdf ? '' : 'disabled'}>${icons.play}</button>
        </div>`).join('')}
    </div>`;

  host.querySelectorAll('[data-batch]').forEach(row => {
    row.querySelector('.row')?.addEventListener('click', () => ctx.navigate(`#/preview/${row.dataset.batch}`));
    row.querySelector('[data-batch-print]')?.addEventListener('click', async (event) => {
      event.stopPropagation();
      const id = event.currentTarget.dataset.batchPrint;
      try { await api.print(id, {}); toast('Sent to the printer'); } catch (e) { toast('Failed', e.message, 'err'); }
    });
  });

  host.querySelector('#pv-print-all')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.classList.add('spin');
    let sent = 0;
    for (const item of ready) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await api.print(item.id, {});
        sent++;
      } catch { /* keep going */ }
    }
    button.classList.remove('spin');
    button.disabled = false;
    toast(sent ? `Queued ${sent} job(s)` : 'Nothing could be queued', '', sent ? 'ok' : 'err');
  });
}

export function destroy(container) {
  container._cleanup?.();
}
