/* Your print — one document, exactly as it will come out, plus its code.
 *
 * The page has one job: let the person see the output, choose how it prints and
 * where, press Print, and then hold on to the code that print command got. The
 * code is the spine of this screen — before printing the card explains what a
 * code is, after printing it *is* the screen, updating live.
 */

import { api } from '../api.js';
import { store } from '../store.js';
import { chosenPrinter, setChosenPrinter, rememberCode } from '../prefs.js';
import {
  esc, icon, icons, toast, progressBar, statusChip, statusMeta, ticketPanel, ticketOf,
  fmtBytes, fmtAgo, confirmDialog, note, emptyState, pageLabel, ACTIVE_STATUSES,
} from '../ui.js';

const view = {
  id: null,
  page: 1,
  zoom: 1,
  fit: true,
  selected: new Set(),
  rangeMode: false,
  thumbLimit: 14,
  busy: false,
  options: null,
};

const ZOOMS = [0.5, 0.6, 0.75, 0.9, 1, 1.15, 1.35, 1.6, 2];

export async function render(container, params, ctx) {
  view.id = params.id;
  view.page = 1;
  view.zoom = 1;
  view.fit = true;
  view.selected.clear();
  view.rangeMode = false;
  view.busy = false;

  const job = store.state.jobs.get(view.id) || await api.job(view.id).catch(() => null);
  if (!job) {
    container.innerHTML = `<section class="view"><div class="card">${emptyState({
      iconName: 'alert',
      title: 'Print not found',
      text: 'It may have been removed from this device\'s history.',
      action: '<a class="btn primary" href="#/print">Print something</a>',
    })}</div></section>`;
    return {};
  }
  store.upsertJob(job);
  view.options = { ...defaults(), ...(job.options || {}) };

  container.innerHTML = shell(job);
  bindCopy(container);
  bindStage(container, job);
  bindOptions(container, job, ctx);
  bindActions(container, job, ctx);
  renderThumbs(container, job);
  paintTicket(container, job);
  paintStageCount(container, job);

  return {
    update(type) {
      const fresh = store.state.jobs.get(view.id);
      if (!fresh) return;
      if (type === 'job' || type === 'hello' || type === 'resync' || type === 'boot') {
        const before = job.status;
        Object.assign(job, fresh);
        paintTicket(container, job);
        paintStageCount(container, job);
        if (!job.hasPdf && fresh.hasPdf) renderThumbs(container, fresh);
        if (before !== fresh.status && ['printed', 'failed'].includes(fresh.status)) {
          container.querySelector('#job-status-card')?.classList.add('just-printed');
        }
        if (fresh.renderedPages !== job.renderedPages) renderThumbs(container, fresh);
      }
      if (type === 'settings') paintSummary(container);
    },
    destroy() { container._cleanup?.(); },
  };
}

function defaults() {
  const s = store.state.settings || {};
  return { copies: s.copies || 1, paper: s.paper || 'A4', duplex: Boolean(s.duplex), scale: s.scale || 'fit', range: '' };
}

/* ---------------- markup ---------------- */

function shell(job) {
  return `
  <section class="view">
    <div class="view-head spread wrap">
      <div class="grow">
        <h1 class="truncate">${esc(job.name)}</h1>
        <p><span id="pv-pages">${esc(pageLabel(job))}</span> · ${esc(fmtBytes(job.size))} · ${esc(fmtAgo(job.createdAt))}</p>
      </div>
      <div class="row">
        <a class="btn sm ghost" href="#/print">${icons.upload}<span>Add another</span></a>
        <a class="btn sm ghost" href="#/history">${icons.list}<span>History</span></a>
      </div>
    </div>

    <div class="preview-layout">
      <div class="stage">
        <div class="stage-toolbar">
          <button class="icon-btn" id="pv-prev" title="Previous page" aria-label="Previous page">${icons.chevronLeft}</button>
          <button class="icon-btn" id="pv-next" title="Next page" aria-label="Next page">${icons.chevronRight}</button>
          <span class="chip" id="pv-page-chip">Page 1</span>
          <span class="grow"></span>
          <button class="icon-btn" id="pv-zoom-out" title="Zoom out" aria-label="Zoom out">${icons.zoomOut}</button>
          <span class="zoom-value" id="pv-zoom">fit</span>
          <button class="icon-btn" id="pv-zoom-in" title="Zoom in" aria-label="Zoom in">${icons.zoomIn}</button>
          <button class="btn sm ghost" id="pv-fit">Fit</button>
          <button class="btn sm ghost" id="pv-select-pages">${icons.check}<span>Pages</span></button>
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
        <div id="job-status-card"></div>

        <div class="card">
          <div class="card-head">
            <h3>${icon('printer')} Print settings</h3>
            <span class="grow"></span>
            <span class="chip" id="pv-toprint">printer</span>
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
            <div class="opt-block" style="grid-column:1/-1">
              <span class="opt-label">Pages <span class="muted small" id="pv-range-hint">all pages</span></span>
              <input class="input" id="pv-range" placeholder="e.g. 1-3, 5" spellcheck="false" autocomplete="off">
            </div>
          </div>

          <div class="summary-line" id="pv-summary" style="margin-top:14px"></div>

          <div class="row" style="margin-top:14px">
            <button class="btn primary lg grow" id="pv-print">${icons.printer}<span>Print now</span></button>
          </div>
          <div class="small muted" id="pv-target-line" style="margin-top:8px"></div>

          <div class="row wrap" style="margin-top:12px">
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

/* ---------------- the code ---------------- */

function paintTicket(container, job) {
  const host = container.querySelector('#job-status-card');
  if (!host) return;

  const ticket = ticketOf(job);
  const active = ACTIVE_STATUSES.includes(job.status);
  const meta = statusMeta(job.status);

  if (!ticket) {
    // No print command yet: explain what the code will be.
    const body = job.hasPdf
      ? `<div class="small muted">Ready. Press <b>Print now</b> and this screen will show a print code you can follow.</div>`
      : `${progressBar(job.progress || 0)}<div class="small muted" style="margin-top:8px">${esc(job.phase || meta.label)}…</div>`;
    host.className = 'card';
    host.innerHTML = `
      <div class="spread wrap">
        <span class="chip ${meta.cls}">${esc(meta.label)}</span>
        <span class="muted small">${esc(job.phase || '')}</span>
      </div>
      <div style="margin-top:12px">${body}</div>
      ${job.status === 'failed' ? `<div style="margin-top:10px">${note(esc(job.error || 'Printing failed'), 'warn')}</div>` : ''}`;
    return;
  }

  const actions = active
    ? `<button class="btn sm ghost" data-act="cancel">${icons.x}<span>Stop</span></button>`
    : `<button class="btn sm soft" data-act="reprint">${icons.retry}<span>Print again</span></button>`;

  host.className = '';
  host.innerHTML = ticketPanel({ job, ticket, actions });

  host.querySelector('[data-act="cancel"]')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await api.cancel(job.id);
      toast('Print stopped', 'It will not come out', 'info');
    } catch (e) {
      toast('Could not stop it', e.message, 'err');
    }
  });

  host.querySelector('[data-act="reprint"]')?.addEventListener('click', (event) => {
    event.currentTarget.disabled = true;
    send(container, job);
  });
}

function paintStageCount(container, job) {
  const el = container.querySelector('#pv-pages');
  if (el) el.textContent = pageLabel(job);
}

/* ---------------- stage ---------------- */

function bindStage(container, job) {
  const canvas = container.querySelector('#pv-canvas');
  const sheet = container.querySelector('#pv-sheet');
  const img = container.querySelector('#pv-img');
  const tag = container.querySelector('#pv-tag');
  const chip = container.querySelector('#pv-page-chip');

  const show = (page) => {
    if (page < 1) return;
    if (job.pageCount && page > job.pageCount) return;
    view.page = page;
    if (job.hasPdf) img.src = api.previewUrl(job.id, page);
    else img.removeAttribute('src');
    sheet.classList.toggle('pending', !job.hasPdf);
    tag.textContent = String(page);
    chip.textContent = job.pageCount ? `Page ${page} / ${job.pageCount}` : `Page ${page}`;
    if (page > view.thumbLimit - 3) {
      view.thumbLimit = Math.min((job.pageCount || view.thumbLimit) + 6, job.pageCount || view.thumbLimit);
      renderThumbs(container, job);
    }
    container.querySelectorAll('#pv-thumbs .thumb').forEach(t => t.classList.toggle('active', Number(t.dataset.page) === page));
  };

  const applyZoom = () => {
    const available = Math.max(220, canvas.clientWidth - 36);
    sheet.style.width = `${available}px`;
    sheet.style.maxWidth = `${available}px`;
    sheet.style.transform = view.fit ? 'none' : `scale(${view.zoom})`;
    sheet.style.transformOrigin = 'top center';
    container.querySelector('#pv-zoom').textContent = view.fit ? 'fit' : `${Math.round(view.zoom * 100)}%`;
  };

  container.querySelector('#pv-prev').addEventListener('click', () => show(view.page - 1));
  container.querySelector('#pv-next').addEventListener('click', () => show(view.page + 1));
  container.querySelector('#pv-zoom-in').addEventListener('click', () => {
    const next = ZOOMS.find(z => z > view.zoom + 0.001);
    view.fit = false;
    view.zoom = next || ZOOMS[ZOOMS.length - 1];
    applyZoom();
  });
  container.querySelector('#pv-zoom-out').addEventListener('click', () => {
    const prev = [...ZOOMS].reverse().find(z => z < view.zoom - 0.001);
    view.fit = false;
    view.zoom = prev || ZOOMS[0];
    applyZoom();
  });
  container.querySelector('#pv-fit').addEventListener('click', () => { view.fit = true; applyZoom(); });
  container.querySelector('#pv-select-pages').addEventListener('click', (event) => {
    view.rangeMode = !view.rangeMode;
    event.currentTarget.classList.toggle('soft', view.rangeMode);
    toast(view.rangeMode ? 'Tap pages to pick them' : 'Page picking off', '', 'info', 1900);
    renderThumbs(container, job);
  });

  img.addEventListener('error', () => toast('That page could not be previewed', 'Printing still works', 'err', 3000));

  const onKey = (event) => {
    if (event.target.matches('input, textarea')) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') show(view.page + 1);
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') show(view.page - 1);
  };
  window.addEventListener('keydown', onKey);
  const onResize = () => applyZoom();
  window.addEventListener('resize', onResize);
  container._cleanup = () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
  };

  show(1);
  applyZoom();
}

function renderThumbs(container, job) {
  const host = container.querySelector('#pv-thumbs');
  if (!host) return;

  if (!job.hasPdf) {
    host.innerHTML = Array.from({ length: 4 }, () => '<div class="thumb skeleton"></div>').join('');
    return;
  }

  const total = Math.max(1, Math.min(job.pageCount || 1, view.thumbLimit, store.state.settings?.maxPreviewPages || 40));
  const items = [];
  for (let page = 1; page <= total; page++) {
    const selected = view.selected.has(page);
    items.push(`
      <button class="thumb ${page === view.page ? 'active' : ''} ${selected ? 'selected' : ''}" data-page="${page}" type="button" aria-label="Page ${page}">
        <img src="${api.previewUrl(job.id, page)}" alt="" loading="lazy">
        <span>${page}</span>
      </button>`);
  }
  if (job.pageCount && job.pageCount > total) items.push('<div class="thumb skeleton"></div>');
  host.innerHTML = items.join('');

  host.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = Number(btn.dataset.page);
      if (!view.rangeMode) { view.fit = true; btn.parentElement.parentElement.querySelector('#pv-fit')?.click(); show(page); return; }
      if (view.selected.has(page)) view.selected.delete(page);
      else view.selected.add(page);
      writeRange(container);
      renderThumbs(container, job);
    });
  });
}

function writeRange(container) {
  const input = container.querySelector('#pv-range');
  if (!input) return;
  const pages = [...view.selected].sort((a, b) => a - b);
  input.value = pages.length ? pages.join(', ') : '';
  paintSummary(container);
}

/* ---------------- options ---------------- */

function bindOptions(container, job, ctx) {
  const s = view.options;

  const paintBase = () => {
    container.querySelector('#pv-copies').textContent = String(s.copies);
    const papers = store.state.settings?.papers || [{ id: 'A4', label: 'A4' }, { id: 'Letter', label: 'Letter' }];
    container.querySelector('#pv-paper').innerHTML = papers
      .map(p => `<button data-paper="${esc(p.id)}" class="${s.paper === p.id ? 'active' : ''}">${esc(p.label)}</button>`).join('');
    container.querySelectorAll('#pv-paper button').forEach(b => b.addEventListener('click', () => {
      s.paper = b.dataset.paper;
      paintBase();
      paintSummary(container);
    }));
    container.querySelectorAll('#pv-scale button').forEach(b => b.classList.toggle('active', b.dataset.scale === s.scale));
    container.querySelector('#pv-duplex').checked = Boolean(s.duplex);
    container.querySelector('#pv-duplex-label').textContent = s.duplex ? 'On' : 'Off';
    const range = container.querySelector('#pv-range');
    if (document.activeElement !== range) range.value = s.range || '';
  };

  container.querySelector('#pv-copies-minus').addEventListener('click', () => { s.copies = Math.max(1, s.copies - 1); paintBase(); paintSummary(container); });
  container.querySelector('#pv-copies-plus').addEventListener('click', () => { s.copies = Math.min(50, s.copies + 1); paintBase(); paintSummary(container); });
  container.querySelectorAll('#pv-scale button').forEach(b => b.addEventListener('click', () => {
    s.scale = b.dataset.scale;
    paintBase();
    paintSummary(container);
  }));
  container.querySelector('#pv-duplex').addEventListener('change', (event) => {
    s.duplex = event.target.checked;
    container.querySelector('#pv-duplex-label').textContent = s.duplex ? 'On' : 'Off';
    paintSummary(container);
  });
  container.querySelector('#pv-range').addEventListener('input', (event) => {
    s.range = event.target.value.replace(/[^0-9,\-\s]/g, '').slice(0, 120);
    paintSummary(container);
  });

  paintBase();
  paintSummary(container);
}

function paintSummary(container) {
  const s = view.options;
  const printer = currentPrinter();
  const doubleSided = s.duplex ? 'two-sided' : 'one side';
  const scale = s.scale === 'actual' ? 'actual size' : 'fit to page';
  container.querySelector('#pv-summary').innerHTML = `
    <span><b>${s.copies}</b> ${s.copies === 1 ? 'copy' : 'copies'}</span>
    <span>${esc(s.paper)}</span>
    <span>${esc(scale)}</span>
    <span>${esc(doubleSided)}</span>
    <span>${s.range ? `pages <b>${esc(s.range)}</b>` : 'all pages'}</span>`;

  const toEl = container.querySelector('#pv-toprint');
  if (toEl) {
    toEl.textContent = printer ? printer.name : 'no printer';
    toEl.className = `chip ${printer && printer.status === 'ready' ? 'printed' : ''}`;
  }
  const line = container.querySelector('#pv-target-line');
  if (line) {
    line.textContent = printer
      ? `Sending to ${printer.name}${printer.detail ? ` · ${printer.detail}` : ''}`
      : 'Choose a printer on the Print tab first.';
  }
}

function currentPrinter() {
  const id = chosenPrinter() || store.preferredPrinter();
  return (store.state.printers || []).find(p => p.id === id) || store.printerList()[0] || null;
}

/* ---------------- actions ---------------- */

function bindCopy(container) {
  container.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-copy]');
    if (!btn) return;
    navigator.clipboard.writeText(btn.dataset.copy)
      .then(() => toast('Print code copied', btn.dataset.copy, 'ok', 2200))
      .catch(() => toast('Copy it by hand', btn.dataset.copy, 'info', 3200));
  });
}

function bindActions(container, job, ctx) {
  container.querySelector('#pv-print').addEventListener('click', (event) => {
    event.currentTarget.disabled = true;
    send(container, job);
  });

  container.querySelector('#pv-delete').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete this print?',
      message: `"${job.name}" and its preview will be removed from the server.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.remove(job.id);
      store.state.jobs.delete(job.id);
      store.emit('jobDeleted', job.id);
      toast('Deleted');
      ctx.navigate('#/history');
    } catch (e) {
      toast('Could not delete', e.message, 'err');
    }
  });
}

/** Send the print command. The response carries the new code. */
async function send(container, job) {
  if (view.busy) return;
  view.busy = true;

  const target = (currentPrinter() || {}).id || null;
  if (target) setChosenPrinter(target);

  try {
    const updated = await api.print(job.id, {
      copies: view.options.copies,
      paper: view.options.paper,
      duplex: view.options.duplex,
      scale: view.options.scale,
      range: view.options.range,
      target: target || undefined,
    });
    store.upsertJob(updated);
    Object.assign(job, updated);
    if (updated.token) {
      rememberCode(updated.token);
      toast('Print command sent', `Your code is ${updated.token}`, 'ok', 8000);
    }
    paintTicket(container, job);
  } catch (e) {
    toast('Could not print', e.message, 'err', 7000);
    paintTicket(container, job);
  } finally {
    view.busy = false;
    const printBtn = container.querySelector('#pv-print');
    if (printBtn) printBtn.disabled = false;
  }
}
