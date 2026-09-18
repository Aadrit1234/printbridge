/* Shared UI kit — icons, formatters, toasts, dialogs and common fragments.
 *
 * Iconography: every icon below is a Lucide icon (https://lucide.dev, ISC
 * License) inlined as an SVG string in Lucide's native 24×24 stroke geometry.
 * Inline rather than a font or a CDN sprite so the app renders instantly,
 * offline, and identically everywhere. There are no emoji or text glyphs used
 * as icons anywhere in the UI. */

export const icons = {
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3"/></svg>',
  printer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V4h12v5"/><rect x="3" y="9" width="18" height="7" rx="2"/><path d="M7 16h10v4H7z"/></svg>',
  queue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 11v5"/><path d="M12 8h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/></svg>',
  retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.2"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>',
  scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3"/><path d="M3 12h18"/></svg>',
  wifi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 12.5a11 11 0 0 1 14 0"/><path d="M8.5 16a6 6 0 0 1 7 0"/><path d="M12 19h.01"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.7 3 2.7 15 0 18M12 3c-2.7 3-2.7 15 0 18"/></svg>',
  usb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 21V7"/><circle cx="12" cy="4.5" r="2.2"/><path d="M12 11l-4 2H6.5v3H10l2-1.5"/><path d="M12 14l4-2h1.5v3.5H14L12 14"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7Z"/><path d="M14 3v4h4"/></svg>',
  command: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/></svg>',
  zoomIn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M11 8.5v5M8.5 11h5"/><path d="m16 16 4 4"/></svg>',
  zoomOut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M8.5 11h5"/><path d="m16 16 4 4"/></svg>',
  chevronLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14 6-6 6 6 6"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m10 6 6 6-6 6"/></svg>',
  spiral: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v5h-5"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z"/></svg>',
  wrench: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 4a5.5 5.5 0 0 0-4.9 8L4 18.6 5.4 20l6.6-6.6A5.5 5.5 0 0 0 20 9.5L17 12l-2.5-2.5L17 7l-1.5-3Z"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3Z"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>',
};

export function icon(name, cls = '') {
  return `<span class="icon ${cls}">${icons[name] || ''}</span>`;
}

/* ---------------- text helpers ---------------- */

export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtAgo(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return fmtDateTime(iso);
}

/** For future timestamps (session expiry) — the mirror of fmtAgo. */
export function fmtUntil(iso) {
  if (!iso) return 'no expiry';
  const diff = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diff)) return 'no expiry';
  if (diff <= 0) return 'expired';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

export function pageLabel(job) {
  if (!job.pageCount) return 'converting…';
  return `${job.pageCount} page${job.pageCount === 1 ? '' : 's'}`;
}

/* ---------------- status ---------------- */

const STATUS = {
  uploading: { label: 'Uploading', cls: 'uploading' },
  converting: { label: 'Preparing', cls: 'converting' },
  ready: { label: 'Ready', cls: 'ready' },
  queued: { label: 'Queued', cls: 'queued' },
  waiting: { label: 'Waiting for printer', cls: 'waiting' },
  printing: { label: 'Printing', cls: 'printing' },
  printed: { label: 'Printed', cls: 'printed' },
  failed: { label: 'Failed', cls: 'failed' },
  canceled: { label: 'Canceled', cls: 'canceled' },
};

export function statusMeta(status) {
  return STATUS[status] || { label: status || 'unknown', cls: 'canceled' };
}

export function statusChip(status) {
  const meta = statusMeta(status);
  return `<span class="chip ${meta.cls}">${esc(meta.label)}</span>`;
}

export const ACTIVE_STATUSES = ['uploading', 'converting', 'queued', 'waiting', 'printing'];

/* ---------------- toasts ---------------- */

export function toast(title, message = '', kind = 'ok', timeout = 4200) {
  const host = document.getElementById('toaster');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  const ico = kind === 'err' ? icons.alert : kind === 'info' ? icons.info : icons.check;
  node.innerHTML = `${ico}<div class="t-body"><div class="t-title">${esc(title)}</div>${message ? `<div class="t-msg">${esc(message)}</div>` : ''}</div>`;
  host.appendChild(node);
  const remove = () => { node.style.opacity = '0'; setTimeout(() => node.remove(), 220); };
  node.addEventListener('click', remove);
  setTimeout(remove, timeout);
}

export function announce(text) {
  const region = document.getElementById('live-region');
  if (region) region.textContent = text;
}

/* ---------------- dialogs ---------------- */

export function closeOverlay() {
  const host = document.getElementById('overlay-host');
  if (host) host.innerHTML = '';
}

export function openOverlay(html, { onMount } = {}) {
  const host = document.getElementById('overlay-host');
  host.innerHTML = `<div class="overlay" data-overlay>${html}</div>`;
  const overlay = host.querySelector('[data-overlay]');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { closeOverlay(); document.removeEventListener('keydown', onKey); }
  });
  if (onMount) onMount(overlay);
  return overlay;
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const overlay = openOverlay(`
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><h2>${esc(title)}</h2></div>
        <div class="modal-body"><p class="muted">${esc(message)}</p></div>
        <div class="modal-foot">
          <button class="btn ghost" data-cancel>Cancel</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" data-confirm>${esc(confirmLabel)}</button>
        </div>
      </div>`);
    const finish = (value) => { closeOverlay(); resolve(value); };
    overlay.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-confirm]').addEventListener('click', () => finish(true));
  });
}

/* ---------------- fragments ---------------- */

export function progressBar(percent, cls = '') {
  const pct = Math.max(0, Math.min(100, Math.round(percent || 0)));
  return `<div class="progress ${cls}"><i style="width:${pct}%"></i></div>`;
}

/* Thumbnails are plain <img> requests, which cannot carry custom headers, so
 * each app supplies its own URL builder (guest URLs carry the device id, admin
 * URLs the session). Without this the shared kit would hardcode one surface. */
let thumbUrlBuilder = (id) => `/api/v1/files/${encodeURIComponent(id)}/thumb.png`;

export function setThumbUrlBuilder(fn) {
  if (typeof fn === 'function') thumbUrlBuilder = fn;
}

export function jobThumb(job) {
  if (job.status === 'failed' || job.status === 'canceled') return `<div class="job-thumb">${icons.file}</div>`;
  if (!job.hasPdf) return `<div class="job-thumb">${icons.spiral}</div>`;
  return `<div class="job-thumb"><img src="${esc(thumbUrlBuilder(job.id))}" alt="" loading="lazy" onerror="this.remove()"></div>`;
}

/* ---------------- print codes (tickets) ----------------
 *
 * Every print command gets its own code, so both the person who pressed Print
 * and the admin reading the queue can point at the same print. These helpers
 * are the single place that turns a ticket into markup. */

/** The code of the print command this job is on right now. */
export function tokenOf(job) {
  if (!job) return null;
  if (job.token) return job.token;
  const list = Array.isArray(job.tickets) ? job.tickets : [];
  return list.length ? list[list.length - 1].token : null;
}

/** The live ticket (the newest one) of a job. */
export function ticketOf(job) {
  const list = job && Array.isArray(job.tickets) ? job.tickets : [];
  return list.length ? list[list.length - 1] : null;
}

/** All tickets of a job, newest first — one entry per print command. */
export function ticketsOf(job) {
  const list = job && Array.isArray(job.tickets) ? job.tickets : [];
  return [...list].reverse();
}

const TICKET_STATES = {
  queued: { label: 'Queued', cls: 'queued' },
  waiting: { label: 'Waiting for printer', cls: 'waiting' },
  printing: { label: 'Printing', cls: 'printing' },
  printed: { label: 'Printed', cls: 'printed' },
  failed: { label: 'Failed', cls: 'failed' },
  canceled: { label: 'Canceled', cls: 'canceled' },
};

export function ticketStateMeta(state) {
  return TICKET_STATES[state] || { label: state || 'queued', cls: 'queued' };
}

/** just the code, as an inline chip */
export function printCode(token) {
  if (!token) return '';
  return `<span class="code-inline" title="Print code for this print command">${esc(token)}</span>`;
}

const TRACK = [
  { key: 'queued', label: 'Queued' },
  { key: 'printing', label: 'Printing' },
  { key: 'printed', label: 'Printed' },
];

/**
 * The three-step tracker under a code: where this print command has got to.
 * "waiting" is shown as queued-and-still-trying, which is what it is from the
 * outside: the printer has not taken it yet.
 */
export function ticketTrack(ticket) {
  const state = ticket ? ticket.state : 'queued';
  const failed = state === 'failed' || state === 'canceled';
  const reached = state === 'printed' ? 3 : state === 'printing' ? 1 : 0;

  const steps = TRACK.map((step, index) => {
    const done = reached > index;
    const current = !failed && reached === index;
    const cls = [done ? 'done' : '', current ? 'current' : ''].filter(Boolean).join(' ');
    return `
      <div class="track-step ${cls}">
        <span class="bullet">${done ? icons.check : index + 1}</span>
        <span>${esc(step.label)}</span>
      </div>`;
  }).join('');

  return `<div class="ticket-track" role="list">${steps}</div>`;
}

/**
 * The ticket panel: the code, what it is for, and its live state.
 * Used by the job screen, the history detail and — in admin — the queue.
 */
export function ticketPanel({ job, ticket, actions = '' } = {}) {
  const t = ticket || ticketOf(job) || { state: 'queued', token: null, at: job && job.updatedAt };
  const meta = ticketStateMeta(t.state);
  const done = t.state === 'printed';
  const bad = t.state === 'failed' || t.state === 'canceled';
  const parts = String(t.token || '').split('-');

  const detail = [];
  if (t.copies) detail.push(`${t.copies} ${t.copies === 1 ? 'copy' : 'copies'}`);
  if (t.paper) detail.push(t.paper);
  if (t.duplex) detail.push('two-sided');
  if (t.targetName || t.target) detail.push(t.targetName || String(t.target).replace(/^[a-z]+:/i, ''));
  if (t.backend) detail.push(`via ${t.backend}`);

  return `
  <section class="ticket ${done ? 'done' : ''} ${bad ? 'bad' : ''}" data-token="${esc(t.token || '')}">
    <div class="ticket-head">
      <span class="label">Print code</span>
      <div class="ticket-code" id="ticket-code">
        ${parts.map(part => `<span class="seg">${esc(part)}</span>`).join('')}
      </div>
      <div class="small muted">${done ? 'Printed' : 'Read this out, or keep it to check later'} · ${esc(job ? job.name : '')}</div>
    </div>
    <div class="ticket-meta">
      <span class="chip ${meta.cls}">${esc(meta.label)}</span>
      ${detail.length ? `<span>${detail.map(esc).join(' · ')}</span>` : ''}
      ${t.at ? `<span class="muted">opened ${esc(fmtAgo(t.at))}</span>` : ''}
    </div>
    <div class="ticket-body">
      ${ticketTrack(t)}
      ${t.message ? `<div class="small muted">${esc(t.message)}</div>` : ''}
      ${t.error ? `<div class="job-error">${esc(t.error)}</div>` : ''}
      <div class="ticket-actions">
        ${t.token ? `<button class="btn sm ghost" data-copy="${esc(t.token)}">${icons.copy}<span>Copy code</span></button>` : ''}
        ${done ? `<span class="chip printed">${icons.check}<span>finished</span></span>` : ''}
        ${actions}
      </div>
    </div>
  </section>`;
}

/** Delegated: any [data-copy] button copies its value. */
export function bindCopyButtons(host) {
  host.addEventListener('click', (event) => {
    const button = event.target.closest('[data-copy]');
    if (button) copyText(button.dataset.copy, 'Print code copied');
  });
}

export function jobRow(job, { actions = '', showProgress = true, extra = '', showCode = true } = {}) {
  const meta = statusMeta(job.status);
  const active = ACTIVE_STATUSES.includes(job.status);
  const detail = [];
  if (job.pageCount) detail.push(`${job.pageCount} page${job.pageCount === 1 ? '' : 's'}`);
  if (job.size) detail.push(fmtBytes(job.size));
  detail.push(fmtAgo(job.createdAt));

  const progress = showProgress && active ? `
    <div style="margin-top:2px">
      ${progressBar(job.progress)}
      <div class="job-note" style="margin-top:4px">${esc(job.phase || meta.label)}${job.message ? ' · ' + esc(job.message) : ''}</div>
    </div>` : '';

  const note = !active && job.error ? `<div class="job-error">${esc(job.error)}</div>`
    : !active && job.message ? `<div class="job-note">${esc(job.message)}</div>` : '';

  return `
    <div class="job-row ${active ? 'active' : ''}" data-job="${esc(job.id)}">
      ${jobThumb(job)}
      <div class="job-info">
        <div class="job-title">
          <span class="job-name truncate">${esc(job.name)}</span>
          ${job.system ? '<span class="chip">auto</span>' : ''}
        </div>
        <div class="job-meta">
          <span>${detail.map(esc).join(' · ')}</span>
          ${job.backend ? `<span>via ${esc(job.backend)}</span>` : ''}
          ${extra}
        </div>
        ${showCode && tokenOf(job) ? `<div class="row" style="gap:8px">${printCode(tokenOf(job))}${ticketOf(job) ? `<span class="small muted">${esc(ticketStateMeta(ticketOf(job).state).label)}</span>` : ''}</div>` : ''}
        ${progress}
        ${note}
      </div>
      <div class="job-side">
        <span class="chip ${meta.cls}">${esc(meta.label)}</span>
        <div class="job-actions">${actions}</div>
      </div>
    </div>`;
}

export function emptyState({ iconName = 'printer', title, text, action = '' }) {
  return `
    <div class="empty">
      <div class="empty-icon">${icons[iconName] || icons.printer}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      ${action}
    </div>`;
}

export function note(text, kind = 'info') {
  const ico = kind === 'warn' ? icons.alert : kind === 'ok' ? icons.check : icons.info;
  return `<div class="note ${kind}">${ico}<div>${text}</div></div>`;
}

export async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, '', 'ok');
  } catch {
    toast('Could not copy', 'Copy it manually instead', 'err');
  }
}

export function mount(container, html) {
  container.innerHTML = html;
  return container.firstElementChild;
}
