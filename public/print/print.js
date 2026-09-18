/* PrintBridge — walk-up printing site.
 *
 * A tiny self-contained SPA: a person standing in front of a printer enters the
 * code on its sticker (PP-XXXX-XXXX) and is walked through sending a document
 * to it. Workspace printers are free; shop printers show a per-page price and
 * a (demo) checkout. All state lives in sessionStorage so a refresh keeps the
 * flow; recent printer codes and print tokens live in localStorage.
 *
 * API base comes from /config.js (window.PRINTBRIDGE_CONFIG.apiBase, set by
 * the server); every request carries the X-Device-Id header.
 */
(function () {
  'use strict';

  var CFG = window.PRINTBRIDGE_CONFIG || {};
  var ORIGIN = String(CFG.apiBase || '').replace(/\/+$/, '');
  var BASE = ORIGIN + '/api/v1';

  var DEVICE_KEY = 'printbridge.device';
  var RECENT_CODES_KEY = 'printbridge.recentCodes';
  var RECENT_TOKENS_KEY = 'printbridge.recentTokens';
  var SESSION_KEY = 'printbridge.print.session';

  var ALLOWED_MIMES = [
    'pdf', 'jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'bmp', 'tif', 'tiff',
    'txt', 'csv', 'log', 'md', 'doc', 'docx', 'odt', 'rtf', 'ppt', 'pptx', 'xls', 'xlsx', 'ods',
  ];
  var MAX_FILES = 10;
  var PAPERS_ORDER = ['a4', 'letter', 'legal', 'a5'];

  var CURRENCY_SYMBOLS = { INR: '\u20B9', USD: '$', EUR: '\u20AC', GBP: '\u00A3' };

  /* Paper size → width:height, so the preview can flip with the orientation. */
  var SHEET_RATIOS = {
    a4: { portrait: 210 / 297, landscape: 297 / 210 },
    letter: { portrait: 8.5 / 11, landscape: 11 / 8.5 },
    legal: { portrait: 8.5 / 14, landscape: 14 / 8.5 },
    a5: { portrait: 148 / 210, landscape: 210 / 148 },
  };

  var FLOWS = {
    workspace: ['code', 'details', 'upload', 'settings', 'token'],
    shop: ['code', 'mode', 'details', 'upload', 'settings', 'payment', 'token'],
  };

  var STEP_LABELS = {
    code: 'Code', mode: 'Mode', details: 'Printer', upload: 'Files',
    settings: 'Settings', payment: 'Payment', token: 'Done',
  };

  /* ------------------------------------------------------------- helpers */

  function $(sel, el) { return (el || document).querySelector(sel); }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function cap(value) {
    return String(value || '').charAt(0).toUpperCase() + String(value || '').slice(1);
  }

  function fmtBytes(n) {
    var value = Number(n) || 0;
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    return (value / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function money(amount, currency) {
    var sym = CURRENCY_SYMBOLS[currency] || (currency ? currency + ' ' : '\u20B9');
    var value = Number(amount || 0);
    return sym + (Number.isInteger(value) ? value : value.toFixed(2));
  }

  /* ---------------------------------------------------- device identity */

  var device = null;

  function deviceId() {
    if (device) return device;
    try {
      var saved = localStorage.getItem(DEVICE_KEY);
      if (saved && /^[0-9a-zA-Z_-]{4,64}$/.test(saved)) { device = saved; return saved; }
    } catch (e) { /* private mode */ }
    var bytes = new Uint8Array(9);
    if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    var hex = '';
    for (var j = 0; j < bytes.length; j++) hex += bytes[j].toString(16).padStart(2, '0');
    device = 'dev_' + hex;
    try { localStorage.setItem(DEVICE_KEY, device); } catch (e) { /* private mode */ }
    return device;
  }

  /* ------------------------------------------------------------- API */

  function ApiError(message, status, payload) {
    this.name = 'ApiError';
    this.message = message;
    this.status = status == null ? 0 : status;
    this.payload = payload || null;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'X-Device-Id': deviceId() };
    var options = { method: opts.method || 'GET', headers: headers };
    if (opts.form) {
      options.body = opts.form;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(opts.body);
    }
    var res;
    try {
      res = fetch(BASE + path, options);
    } catch (err) {
      return Promise.reject(new ApiError('Cannot reach the print server — check your connection.'));
    }
    return res.then(function (r) {
      return r.json().catch(function () { return null; }).then(function (payload) {
        if (!r.ok) {
          var message = (payload && payload.error) || 'Request failed (' + r.status + ')';
          throw new ApiError(message, r.status, payload);
        }
        return payload;
      });
    });
  }

  /* ------------------------------------------------------------- state */

  var state = {
    code: null,
    printer: null,
    mode: null,                       // 'color' | 'mono' (shop only)
    settings: { paper: 'a4', orientation: 'portrait', duplex: false, color: false },
    files: [],                        // pending File objects (not persisted)
    jobs: [],                         // uploaded: { id, name, size, pageCount }
    payment: null,                    // { currency, perPage, pages, total }
    tokens: [],
    step: 'code',
  };

  function persist() {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(state)); } catch (e) { /* full */ }
  }

  function restore() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      Object.assign(state, saved);
      state.files = [];
      if (!state.settings) state.settings = { paper: 'a4', orientation: 'portrait', duplex: false, color: false };
    } catch (e) { /* corrupt → start over */ }
  }

  function reset() {
    state.code = null;
    state.printer = null;
    state.mode = null;
    state.settings = { paper: 'a4', orientation: 'portrait', duplex: false, color: false };
    state.files = [];
    state.jobs = [];
    state.payment = null;
    state.tokens = [];
    state.step = 'code';
    persist();
  }

  function flowOf() { return (state.printer && state.printer.category === 'shop') ? 'shop' : 'workspace'; }

  /* recent printer codes + print tokens (localStorage) */
  function recentCodes() {
    try { return JSON.parse(localStorage.getItem(RECENT_CODES_KEY) || '[]'); } catch (e) { return []; }
  }
  function rememberCode(code) {
    var list = recentCodes().filter(function (c) { return c !== code; });
    list.unshift(code);
    try { localStorage.setItem(RECENT_CODES_KEY, JSON.stringify(list.slice(0, 6))); } catch (e) { /* full */ }
  }
  /* Print codes this phone has been given, newest first. Older builds stored
   * bare strings, so both shapes are read. */
  function recentTokens() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(RECENT_TOKENS_KEY) || '[]'); } catch (e) { return []; }
    if (!Array.isArray(raw)) return [];
    return raw.map(function (entry) {
      if (typeof entry === 'string') return { token: entry, label: '', at: null };
      return { token: String(entry.token || ''), label: String(entry.label || ''), at: entry.at || null };
    }).filter(function (entry) { return entry.token; });
  }

  function rememberToken(token, label) {
    if (!token) return;
    var list = recentTokens().filter(function (t) { return t.token !== token; });
    list.unshift({ token: token, label: label || '', at: new Date().toISOString() });
    try { localStorage.setItem(RECENT_TOKENS_KEY, JSON.stringify(list.slice(0, 6))); } catch (e) { /* full */ }
  }

  /* The state of a print command, in the words the person at the printer uses. */
  var TICKET_LABELS = {
    queued: { text: 'Queued', cls: 'grey' },
    waiting: { text: 'Waiting for printer', cls: 'on' },
    printing: { text: 'Printing', cls: 'on' },
    printed: { text: 'Printed', cls: 'ok' },
    failed: { text: 'Failed', cls: 'bad' },
    canceled: { text: 'Canceled', cls: 'bad' },
  };

  function ticketChip(state) {
    var meta = TICKET_LABELS[state] || { text: 'Checking…', cls: 'grey' };
    return '<span class="chip ' + meta.cls + '">' + esc(meta.text) + '</span>';
  }

  /* ------------------------------------------------------------- icons */

  var ICONS = {
    printer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8V4h12v4"/><rect x="3" y="8" width="18" height="8" rx="2"/><path d="M6.5 12h5"/><path d="M17.5 12v.01"/><path d="M8 16h8"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5"/><path d="M7 9l5-4 5 4"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v.01"/><path d="M12 11.5V16"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l10 17H2z"/><path d="M12 10v4"/><path d="M12 17v.01"/></svg>',
    card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/><path d="M6.5 14.5h4"/></svg>',
    colour: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18c1.5 0 2.5-1 2.5-2.5 0-.6-.2-1-.6-1.5-.4-.4-.8-.9-.8-1.6 0-.9.8-1.9 1.8-1.9H16a5 5 0 0 0 5-5c0-3.6-4-5.5-9-5.5z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="9.5" cy="7.5" r="1"/><circle cx="14" cy="6.5" r="1"/></svg>',
    mono: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="6" width="17" height="11" rx="2"/><path d="M7 20h10"/><path d="M7 9.5h5"/><path d="M7 12.5h7"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  };

  function icon(name) { return ICONS[name] || ''; }

  /* ---------------------------------------------------------- messaging */

  var toastTimer = null;

  function toast(text, kind) {
    var el = $('#toast');
    el.className = 'toast' + (kind === 'bad' ? ' bad' : kind === 'ok' ? ' ok' : '');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  function note(text, kind) {
    var cls = kind === 'warn' ? ' warn' : kind === 'bad' ? ' bad' : kind === 'ok' ? ' ok' : '';
    return '<div class="note' + cls + '">' + icon(kind === 'ok' ? 'check' : kind === 'warn' ? 'warn' : kind === 'bad' ? 'warn' : 'info') +
      '<span>' + esc(text) + '</span></div>';
  }

  /* ------------------------------------------------- routing + progress */

  function currentIndex() {
    var flow = flowOf();
    var idx = FLOWS[flow].indexOf(state.step);
    return idx === -1 ? 0 : idx;
  }

  function paintProgress() {
    var flow = flowOf();
    var steps = FLOWS[flow];
    var index = currentIndex();

    var track = $('#steps-track');
    track.innerHTML = steps.map(function (key, i) {
      var cls = i < index ? 'done' : i === index ? 'current' : '';
      var body = i < index ? ICONS.check : String(i + 1);
      return '<li class="' + cls + '"><span class="dot">' + body + '</span><span class="label">' +
        esc(STEP_LABELS[key]) + '</span></li>';
    }).join('');

    $('#step-count').textContent = 'Step ' + (index + 1) + ' of ' + steps.length;
    $('#stepper').scrollLeft = $('#stepper').scrollWidth;
  }

  function go(key) {
    var flow = flowOf();
    var steps = FLOWS[flow];
    if (steps.indexOf(key) === -1) key = 'code';
    state.step = key;
    persist();

    var stage = $('.stages');
    for (var i = 0; i < stage.children.length; i++) stage.children[i].classList.remove('active');
    var target = $('#step-' + key);
    target.hidden = false;
    target.classList.add('active');
    paintProgress();
    renderers[key]();
    window.scrollTo({ top: 0 });
  }

  /* -------------------------------------------------- printer: step code */

  function normalizeCode(value) {
    var raw = String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (raw.slice(0, 2) === 'PP') raw = raw.slice(2);
    if (raw.length !== 8) return null;
    return 'PP-' + raw.slice(0, 4) + '-' + raw.slice(4);
  }

  /* Same shape as a printer code, a different prefix: PB- for print commands. */
  function formatCodeInput(value, prefix) {
    var pre = prefix || 'PP';
    var raw = String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (raw.slice(0, 2) === pre) raw = raw.slice(2);
    raw = raw.slice(0, 8);
    var out = pre + '-';
    if (raw.length > 4) out += raw.slice(0, 4) + '-' + raw.slice(4);
    else out += raw;
    return out;
  }

  function normalizeToken(value) {
    var raw = String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (raw.slice(0, 2) === 'PB') raw = raw.slice(2);
    if (raw.length !== 8) return null;
    return 'PB-' + raw.slice(0, 4) + '-' + raw.slice(4);
  }

  /* Ask the server what happened to the codes this phone was given. */
  function paintTicketStates() {
    var list = $('#my-prints');
    if (!list) return;
    var rows = list.querySelectorAll('.ticket-row');
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var token = row.getAttribute('data-token');
        api('/tickets/' + encodeURIComponent(token))
          .then(function (res) {
            var state = res && res.ticket ? res.ticket.state : null;
            var host = row.querySelector('.ticket-state');
            if (host) host.innerHTML = ticketChip(state);
          })
          .catch(function () {
            var host = row.querySelector('.ticket-state');
            if (host) host.innerHTML = ticketChip('failed');
          });
      })(rows[i]);
    }
  }

  function renderCode() {
    var el = $('#step-code');
    var codes = recentCodes();
    var toks = recentTokens();

    el.innerHTML =
      '<div class="view-head"><h1 id="h-code">Print here</h1>' +
      '<p>Enter the code printed on the sticker attached to the printer you are standing at.</p></div>' +
      '<div class="card">' +
      '<form class="code-form" id="code-form">' +
      '<label class="opt"><span class="lbl">Printer code</span>' +
      '<input class="input" id="code-input" placeholder="PP-XXXX-XXXX" autocomplete="off" spellcheck="false" maxlength="11" inputmode="text"></label>' +
      '<div style="margin-top:14px"><button class="btn primary" type="submit" id="code-go">' + icon('printer') + '<span>Find this printer</span></button></div>' +
      '</form>' +
      '<div id="code-result"></div>' +
      (codes.length
        ? '<div class="recent-codes"><span class="small muted">Recent codes</span>' +
          codes.map(function (c) {
            return '<button type="button" class="code-chip" data-code="' + esc(c) + '">' + esc(c) + '</button>';
          }).join('') + '</div>'
        : '<div class="code-hint"><span class="line"></span></div>') +
      (toks.length
        ? '<div class="recent-tokens"><span class="small muted">Your recent prints</span>' +
          '<div class="ticket-list" id="my-prints">' +
          toks.map(function (t) {
            return '<div class="ticket-row" data-token="' + esc(t.token) + '">' +
              '<span class="tok">' + esc(t.token) + '</span>' +
              '<span class="grow small muted truncate">' + esc(t.label || 'Print job') + '</span>' +
              '<span class="ticket-state">' + ticketChip(null) + '</span>' +
              '</div>';
          }).join('') +
          '</div>' +
          '<form class="track-form" id="track-form">' +
          '<input class="input mono" id="track-input" placeholder="Check another code" maxlength="11" autocomplete="off" spellcheck="false">' +
          '<button class="btn ghost" type="submit">Check</button>' +
          '</form>' +
          '<div id="track-result"></div>' +
          '</div>'
        : '') +
      '</div>';

    var input = $('#code-input', el);
    input.value = state.code ? state.code : '';
    input.focus();

    paintTicketStates();
    var track = $('#track-form', el);
    if (track) {
      var trackInput = $('#track-input', el);
      trackInput.addEventListener('input', function () { trackInput.value = formatCodeInput(trackInput.value.replace(/^PB-?/i, ''), 'PB'); });
      track.addEventListener('submit', function (event) {
        event.preventDefault();
        var wanted = normalizeToken(trackInput.value);
        var host = $('#track-result', el);
        if (!wanted) { host.innerHTML = note('A print code looks like PB-XXXX-XXXX.', 'bad'); return; }
        host.innerHTML = note('Checking ' + wanted + '…');
        api('/tickets/' + encodeURIComponent(wanted))
          .then(function (res) {
            var ticket = res && res.ticket;
            if (!ticket) throw new ApiError('No print with that code.');
            host.innerHTML = '<div class="ticket-row found"><span class="tok">' + esc(ticket.token) + '</span>' +
              '<span class="grow small muted truncate">' + esc(ticket.jobName || ticket.label || 'Print job') + '</span>' +
              ticketChip(ticket.state) + '</div>';
          })
          .catch(function (err) {
            host.innerHTML = note(err && err.status === 404
              ? 'No print with that code belongs to this phone.'
              : (err.message || 'Could not check that code.'), 'bad');
          });
      });
    }

    $('#code-form', el).addEventListener('submit', function (event) {
      event.preventDefault();
      submitCode();
    });
    input.addEventListener('input', function () {
      input.value = formatCodeInput(input.value.replace(/PP-?/i, ''));
      var err = $('#code-error', el);
      if (err) { err.remove(); }
    });
    var chips = el.querySelectorAll('.code-chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function () {
        var box = $('#code-input');
        if (box) { box.value = this.getAttribute('data-code'); box.focus(); }
      });
    }
  }

  function submitCode(explicit) {
    var el = $('#step-code');
    var input = $('#code-input', el);
    var code = normalizeCode(explicit || input.value);
    if (!code) {
      toast('That does not look like a printer code (PP-XXXX-XXXX)', 'bad');
      input.focus();
      return;
    }
    var host = $('#code-result', el);
    host.innerHTML = note('Looking up ' + escapeHtmlCode(code) + '…');
    api('/printers/' + encodeURIComponent(code))
      .then(function (res) {
        var printer = res && res.printer;
        if (!printer) throw new ApiError('No printer details came back.');
        state.code = printer.code || code;
        state.printer = printer;
        state.settings = defaultSettings(printer);
        state.step = flowOf() === 'shop' ? 'mode' : 'details';
        rememberCode(state.code);
        persist();
        go(state.step);
      })
      .catch(function (err) {
        if (err && err.status === 404) {
          host.innerHTML = note((err.message || 'No printer has that code.') + ' Double-check the sticker and try again.', 'bad');
        } else {
          host.innerHTML = note(err.message || 'Could not reach the print server.', 'bad');
        }
      });
  }

  function escapeHtmlCode(code) {
    return '<code>' + esc(code) + '</code>';
  }

  function defaultSettings(printer) {
    var c = printer.capabilities || {};
    var papers = (c.papers || ['a4']).filter(function (p) { return PAPERS_ORDER.indexOf(p) !== -1; });
    var orientations = c.orientations || ['portrait', 'landscape'];
    return {
      paper: papers[0] || 'a4',
      orientation: orientations.indexOf('landscape') === -1 ? 'portrait'
        : orientations.indexOf('portrait') === -1 ? 'landscape' : 'portrait',
      duplex: false,
      color: Boolean(printer.capabilities && printer.capabilities.color),
    };
  }

  /* ------------------------------------------------ printer: step mode (shop) */

  function renderMode() {
    var el = $('#step-mode');
    var pricing = state.printer && state.printer.pricing;
    if (!pricing) { toast('This printer has no pricing yet.', 'bad'); return reset(); }

    el.innerHTML =
      '<div class="view-head"><h1>Colour or black &amp; white?</h1>' +
      '<p>' + esc(state.printer.name) + ' charges per page. Pick how you want this printed.</p></div>' +
      '<div class="mode-grid">' +
      '<button type="button" class="mode-card colour" data-mode="color">' +
      '<span class="mode-swatch">' + icon('colour') + '</span>' +
      '<span class="mode-name">Colour</span>' +
      '<span class="mode-rate"><b>' + esc(money(pricing.colorPerPage, pricing.currency)) + '</b> per page</span>' +
      '</button>' +
      '<button type="button" class="mode-card mono" data-mode="mono">' +
      '<span class="mode-swatch">' + icon('mono') + '</span>' +
      '<span class="mode-name">Black &amp; White</span>' +
      '<span class="mode-rate"><b>' + esc(money(pricing.monoPerPage, pricing.currency)) + '</b> per page</span>' +
      '</button>' +
      '</div>' +
      '<div style="margin-top:14px">' + note('Pricing is set by ' + esc(state.printer.name) + '. You can change your mind before paying.', '') + '</div>';

    var cards = el.querySelectorAll('.mode-card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].addEventListener('click', function () {
        state.mode = this.getAttribute('data-mode');
        persist();
        go('details');
      });
    }
  }

  /* --------------------------------------------- printer: step details */

  function capabilityChips(printer) {
    var c = printer.capabilities || {};
    var chips = [];
    (c.papers || []).forEach(function (p) { chips.push(String(p).toUpperCase()); });
    (c.orientations || []).forEach(function (o) { chips.push(cap(o)); });
    if (c.duplex) chips.push('Duplex');
    chips.push(c.color ? 'Colour' : 'Mono');
    return chips.map(function (t) {
      return '<span class="chip' + (t === 'Colour' || t === 'Duplex' ? ' on' : '') + '">' + esc(t) + '</span>';
    }).join(' ');
  }

  function renderDetails() {
    var el = $('#step-details');
    var printer = state.printer;
    if (!printer) { toast('Printer context lost — re-enter the code.', 'bad'); return reset(); }

    var isShop = printer.category === 'shop';
    var pricing = printer.pricing || null;

    var modeLine = '';
    if (isShop && state.mode && pricing) {
      var rate = state.mode === 'color' ? pricing.colorPerPage : pricing.monoPerPage;
      modeLine = '<div class="mode-kept">' + icon(state.mode === 'color' ? 'colour' : 'mono') +
        '<div class="grow"><b>' + (state.mode === 'color' ? 'Colour' : 'Black &amp; White') +
        '</b><div class="small muted">' + money(rate, pricing.currency) + ' per page</div></div></div>';
    }

    var unavailable = printer.active === false;
    var continueBtn = '<button class="btn primary" id="details-go" type="button"' +
      (unavailable ? ' disabled' : '') + '>' +
      (isShop ? 'Continue to upload' : 'Continue') + '</button>';

    el.innerHTML =
      '<div class="view-head"><h1>Your printer</h1><p>Everything this machine can do — check it and continue.</p></div>' +
      (unavailable ? note('This printer is currently unavailable. The owner has paused it — try again later or find another printer.', 'bad') : '') +
      '<div class="card">' +
      '<div class="printer-head">' +
      '<div class="printer-name"><span class="p-icon">' + icon('printer') + '</span>' +
      '<div class="grow"><h2>' + esc(printer.name) + '</h2>' +
      '<div class="small muted" style="margin-top:2px"><code>' + esc(printer.code) + '</code></div>' +
      '</div>' +
      '<span class="chip ' + (unavailable ? 'bad' : 'ok') + '">' + (unavailable ? 'Unavailable' : 'Active') + '</span>' +
      '<span class="chip grey">' + (isShop ? 'Shop' : 'Workspace') + '</span>' +
      '</div>' +
      (printer.note ? '<p class="small muted">' + esc(printer.note) + '</p>' : '') +
      '</div>' +
      '<div class="sec-label">Capabilities</div>' +
      '<div class="row wrap">' + capabilityChips(printer) + '</div>' +
      '</div>' +
      (modeLine ? '<div class="card">' + modeLine + '<div class="small muted" style="margin-top:8px">This choice is locked in for this job.</div></div>' : '') +
      '<div style="margin-top:18px">' + continueBtn + '</div>';

    $('#details-go', el).addEventListener('click', function () { go('upload'); });
  }

  /* ----------------------------------------------- printer: step upload */

  function fileExt(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function renderUpload() {
    var el = $('#step-upload');
    var isShop = flowOf() === 'shop';

    el.innerHTML =
      '<div class="view-head"><h1>Add your document</h1>' +
      '<p>' + (isShop
        ? 'Files are counted as they arrive so your running total stays honest.'
        : 'Send up to 10 files at once — PDF, photos, Office documents, text, anything on the list.') +
      '</p></div>' +
      '<div class="dropzone" id="dropzone">' +
      '<span class="dropzone-icon">' + icon('upload') + '</span>' +
      '<b>Tap to choose files</b>' +
      '<span>or drop them here — up to ' + MAX_FILES + ' per batch</span>' +
      '<div class="kinds">PDF · images · Office · text</div>' +
      '<input type="file" id="file-input" accept="' + ALLOWED_MIMES.map(function (m) { return '.' + m; }).join(',') + '" multiple>' +
      '</div>' +
      '<div id="file-note"></div>' +
      '<div class="card hidden" id="file-card"><div class="file-list" id="file-list"></div></div>' +
      (isShop ? '<div class="summary-line" id="upload-estimate" hidden>' +
        '<span class="lbl" id="upload-est-title">Estimated total</span><span class="amt" id="upload-est-amt"></span>' +
        '</div>' : '') +
      '<div style="margin-top:18px">' +
      '<button class="btn primary" id="upload-go" type="button" disabled>' + icon('upload') + '<span>Upload &amp; continue</span></button>' +
      '<div style="margin-top:10px"><button class="btn ghost hidden" type="button" id="upload-again">Add more files</button></div>' +
      '</div>';

    var input = $('#file-input', el);
    var dz = $('#dropzone', el);
    var list = $('#file-list', el);
    var card = $('#file-card', el);

    function paintFiles() {
      card.classList.remove('hidden');
      list.innerHTML = state.files.map(function (f, i) {
        return '<div class="file-row">' +
          '<span class="file-ico">' + icon('file') + '</span>' +
          '<span class="file-meta"><span class="file-name">' + esc(f.name) + '</span>' +
          '<span class="file-size">' + fmtBytes(f.size) + '</span></span>' +
          '<button type="button" class="remove-btn" data-i="' + i + '" aria-label="Remove ' + esc(f.name) + '">' + icon('warn') + '</button>' +
          '</div>';
      }).join('');
      var goBtn = $('#upload-go', el);
      goBtn.disabled = state.files.length === 0;
      goBtn.querySelector('span').textContent = state.files.length ? 'Upload ' + state.files.length + ' file' + (state.files.length === 1 ? '' : 's') + ' & continue' : 'Upload & continue';
    }

    function addFiles(fileList) {
      var incoming = Array.prototype.slice.call(fileList || []);
      var room = MAX_FILES - state.files.length;
      if (incoming.length > room) {
        toast('This batch holds up to ' + MAX_FILES + ' files — ' + (incoming.length - room) + ' skipped.', 'bad');
        incoming = incoming.slice(0, room);
      }
      for (var i = 0; i < incoming.length; i++) {
        var ext = fileExt(incoming[i].name);
        if (ALLOWED_MIMES.indexOf(ext) === -1) {
          toast(incoming[i].name + ' is not a supported file type.', 'bad');
          continue;
        }
        state.files.push(incoming[i]);
      }
      if (state.files.length >= MAX_FILES) {
        $('#upload-again', el).hidden = false;
        $('#file-input', el).disabled = false;
      }
      persist();
      paintFiles();
    }

    input.addEventListener('change', function () {
      addFiles(input.files);
      input.value = '';
    });

    var dragCount = 0;
    dz.addEventListener('dragenter', function (e) { e.preventDefault(); dragCount++; dz.classList.add('drag'); });
    dz.addEventListener('dragover', function (e) { e.preventDefault(); });
    dz.addEventListener('dragleave', function () { dragCount--; if (dragCount <= 0) dz.classList.remove('drag'); });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      dragCount = 0;
      dz.classList.remove('drag');
      var data = e.dataTransfer.files;
      if (data && data.length) addFiles(data);
    });

    list.addEventListener('click', function (e) {
      var btn = e.target.closest('.remove-btn');
      if (!btn) return;
      state.files.splice(Number(btn.getAttribute('data-i')), 1);
      if (state.files.length < MAX_FILES) $('#upload-again', el).hidden = true;
      persist();
      paintFiles();
    });

    $('#upload-again', el).addEventListener('click', function () { input.click(); });

    $('#upload-go', el).addEventListener('click', function () { uploadFiles(el); });

    paintFiles();
    refreshFileCounts();
  }

  function uploadFiles(el) {
    if (!state.files.length) return;
    var form = new FormData();
    for (var i = 0; i < state.files.length; i++) {
      form.append('files', state.files[i], state.files[i].name);
    }

    // Careful: this used to be called `go`, which shadowed the step router and
    // made the automatic jump to Settings throw ("go is not a function").
    var goBtn = $('#upload-go', el);
    goBtn.disabled = true;
    goBtn.innerHTML = '<span class="spinner"></span><span>Uploading…</span>';
    var host = $('#file-note', el);
    host.innerHTML = '';

    api('/jobs', { method: 'POST', form: form })
      .then(function (res) {
        var jobs = (res && res.jobs) || [];
        var errors = (res && res.errors) || [];
        if (jobs.length) {
          for (var j = 0; j < jobs.length; j++) {
            state.jobs.push({
              id: jobs[j].id,
              name: jobs[j].name,
              size: jobs[j].size || 0,
              pageCount: jobs[j].pageCount || null,
            });
          }
          state.files = [];
          persist();
          var msgs = [];
          if (errors.length) msgs.push(errors.length + ' file(s) were rejected');
          host.innerHTML = note(
            jobs.length + ' file' + (jobs.length === 1 ? '' : 's') + ' uploaded to the printer.' +
            (msgs.length ? ' ' + msgs.join(', ') + '.' : ''), 'ok');
          goBtn.disabled = false;
          goBtn.querySelector('span').textContent = 'Continue to settings';
          setTimeout(function () { go('settings'); }, 650);
        } else {
          var firstError = (errors[0] && errors[0].error) || 'The files could not be uploaded.';
          host.innerHTML = note(firstError, 'bad');
          goBtn.disabled = false;
          goBtn.innerHTML = icon('upload') + '<span>Try again</span>';
        }
      })
      .catch(function (err) {
        host.innerHTML = note(err.message || 'Upload failed — try again.', 'bad');
        goBtn.disabled = false;
        goBtn.innerHTML = icon('upload') + '<span>Try again</span>';
      });
  }

  /* Best-effort: pull real page counts so a shop total is closer than 1/file. */
  function refreshFileCounts() {
    if (flowOf() !== 'shop' || !state.jobs.length) return;
    setTimeout(function () {
      Promise.all(state.jobs.map(function (job) {
        if (job.pageCount) return Promise.resolve(job.pageCount);
        return api('/files/' + encodeURIComponent(job.id) + '/meta')
          .then(function (meta) { return meta && meta.pageCount ? meta.pageCount : null; })
          .catch(function () { return null; });
      })).then(function (counts) {
        var changed = false;
        state.jobs.forEach(function (job, i) {
          if (counts[i] && !job.pageCount) { job.pageCount = counts[i]; changed = true; }
        });
        if (changed) { persist(); if (state.step === 'upload') renderEstimate(); else if (state.step === 'settings') renderEstimate(); }
      });
    }, 2500);
  }

  function estimatePages() {
    return state.jobs.reduce(function (sum, job) { return sum + (job.pageCount || 1); }, 0);
  }

  function perPageRate() {
    var pricing = state.printer && state.printer.pricing;
    if (!pricing || !state.mode) return null;
    return state.mode === 'color' ? pricing.colorPerPage : pricing.monoPerPage;
  }

  function renderEstimate() {
    var pricing = state.printer && state.printer.pricing;
    var rate = perPageRate();
    var el = $('#upload-estimate');
    if (!el) return;
    if (!pricing || !rate) { el.hidden = true; return; }
    el.hidden = false;
    var pages = estimatePages();
    var total = Math.round(pages * rate * 100) / 100;
    $('#upload-est-title').textContent = 'Estimated total · ' + pages + ' page' + (pages === 1 ? '' : 's') + ' × ' + money(rate, pricing.currency);
    $('#upload-est-amt').textContent = money(total, pricing.currency);
  }

  /* --------------------------------------------- printer: step settings */

  function renderSettings() {
    var el = $('#step-settings');
    var printer = state.printer;
    if (!printer) { toast('Printer context lost — re-enter the code.', 'bad'); return reset(); }
    var c = printer.capabilities || {};
    var isShop = flowOf() === 'shop';
    var s = state.settings;

    var papers = (c.papers || []).filter(function (p) { return PAPERS_ORDER.indexOf(p) !== -1; })
      .sort(function (a, b) { return PAPERS_ORDER.indexOf(a) - PAPERS_ORDER.indexOf(b); });
    var orientations = c.orientations || ['portrait', 'landscape'];
    if (!orientations.length) orientations = ['portrait'];

    var paperOpts = papers.map(function (p) {
      return '<option value="' + esc(p) + '"' + (s.paper === p ? ' selected' : '') + '>' + esc(cap(p)) + '</option>';
    }).join('');

    var orientationOpts = orientations.map(function (o) {
      return '<option value="' + esc(o) + '"' + (s.orientation === o ? ' selected' : '') + '>' + esc(cap(o)) + '</option>';
    }).join('');

    var duplexRow = c.duplex
      ? '<div class="check-row"><span class="lbl"><span>Double-sided</span><span class="sub">Print on both sides of the page</span></span>' +
        '<label class="switch"><input type="checkbox" id="set-duplex"' + (s.duplex ? ' checked' : '') + '><span class="track"></span></label></div>'
      : '';

    var colourBlock = '';
    if (isShop) {
      colourBlock = '<div class="check-row">' +
        '<span class="lbl"><span>Colour / Black &amp; white</span><span class="sub">' +
        (state.mode === 'color' ? 'Colour was chosen earlier' : 'Black &amp; white was chosen earlier') +
        '</span></span>' +
        '<label class="switch"><input type="checkbox" disabled' + (state.mode === 'color' ? ' checked' : '') + '><span class="track"></span></label>' +
        '</div>';
    } else if (c.color) {
      colourBlock = '<div class="check-row"><span class="lbl"><span>Colour printing</span><span class="sub">This printer can print in colour</span></span>' +
        '<label class="switch"><input type="checkbox" id="set-color"' + (s.color ? ' checked' : '') + '><span class="track"></span></label></div>';
    } else {
      colourBlock = '<div class="check-row"><span class="lbl"><span>Colour printing</span><span class="sub">Not available — this printer is monochrome</span></span>' +
        '<label class="switch"><input type="checkbox" disabled><span class="track"></span></label></div>';
    }

    var pricing = '';
    if (isShop) {
      var rate = perPageRate();
      if (rate != null) {
        var pages = estimatePages();
        var total = Math.round(pages * rate * 100) / 100;
        pricing = '<div class="summary-line"><span class="lbl">' + pages + ' page' + (pages === 1 ? '' : 's') + ' × ' +
          money(rate, printer.pricing.currency) + '</span><span class="amt">' + money(total, printer.pricing.currency) + '</span></div>';
      }
    }

    el.innerHTML =
      '<div class="view-head"><h1>Print settings</h1>' +
      '<p>' + (isShop ? 'Your colour choice is locked in. Everything else is up to you.' : 'Small things that change how your pages come out.') + '</p></div>' +

      '<div class="preview-stage">' +
      '<div class="preview-bar"><span class="muted">Print preview</span><span class="muted" id="preview-tag"></span></div>' +
      '<div class="preview-canvas"><div class="mock-sheet" id="mock-sheet">' +
      '<span class="mh" id="mock-head"></span>' +
      '<span class="ml"></span><span class="ml semi"></span><span class="ml"></span><span class="ml semi"></span><span class="ml"></span>' +
      '<span class="ml semi"></span><span class="ml"></span>' +
      '<span class="mtag" id="mock-tag"></span>' +
      '</div></div></div>' +

      '<div class="card">' +
      '<div class="sec-label">Paper</div>' +
      '<label class="opt"><span class="lbl">Size</span>' +
      '<select class="input" id="set-paper">' + paperOpts + '</select></label>' +
      '<div class="sec-label">Orientation</div>' +
      '<label class="opt"><span class="lbl">Direction</span>' +
      '<select class="input" id="set-orientation"' + (orientations.length < 2 ? ' disabled' : '') + '>' + orientationOpts + '</select></label>' +
      '<div class="sec-label">Options</div>' +
      duplexRow + colourBlock +
      '</div>' +

      (pricing ? pricing : '') +

      '<div style="margin-top:18px">' +
      '<button class="btn primary" id="settings-go" type="button">' + (isShop ? 'Continue to payment' : 'Print now') + '</button>' +
      '</div>' +
      '<div id="print-result"></div>';

    function paintPreview() {
      var sheet = $('#mock-sheet', el);
      var ratio = SHEET_RATIOS[s.paper] || SHEET_RATIOS.a4;
      var portrait = s.orientation !== 'landscape';
      var ratioVal = portrait ? ratio.portrait : ratio.landscape;
      var base = portrait ? 150 : 210;
      sheet.width = base;
      sheet.style.width = base + 'px';
      sheet.style.height = Math.round(base / ratioVal) + 'px';
      sheet.querySelector('.mh').className = 'mh' + (s.color ? ' color' : '');
      $('#mock-tag', el).textContent = s.paper.toUpperCase() + ' · ' + cap(s.orientation);
      $('#preview-tag', el).textContent = cap(s.orientation) + ' · ' +
        (portrait ? 'tall' : 'wide');
    }

    $('#set-paper', el).addEventListener('change', function (e) { s.paper = e.target.value; persist(); paintPreview(); });
    $('#set-orientation', el).addEventListener('change', function (e) { s.orientation = e.target.value; persist(); paintPreview(); });
    var duplex = $('#set-duplex', el);
    if (duplex) duplex.addEventListener('change', function (e) { s.duplex = e.target.checked; persist(); });
    var colour = $('#set-color', el);
    if (colour) colour.addEventListener('change', function (e) { s.color = e.target.checked; persist(); paintPreview(); });

    $('#settings-go', el).addEventListener('click', function () {
      if (isShop) { go('payment'); }
      else { submitPrint(el); }
    });

    paintPreview();
    renderEstimate();
  }

  /* -------------------------------------------------- printer: step payment */

  function renderPayment() {
    var el = $('#step-payment');
    var pricing = state.printer && state.printer.pricing;
    var rate = perPageRate();
    if (!pricing || rate == null) { toast('Pricing is missing for this printer.', 'bad'); return reset(); }

    var pages = estimatePages();
    var total = Math.round(pages * rate * 100) / 100;

    el.innerHTML =
      '<div class="view-head"><h1>Pay before printing</h1>' +
      '<p>This is a demonstration checkout — no card is charged and no payment is sent anywhere.</p></div>' +

      '<div class="pay-sheet">' +
      '<div class="card" style="background:transparent;border:0;box-shadow:none;padding:0">' +
      '<div class="spread"><span class="muted small">' + esc(state.printer.name) + '</span>' +
      '<span class="chip ' + (state.mode === 'color' ? 'colour on' : '') + '">' + (state.mode === 'color' ? 'Colour' : 'Black &amp; White') + '</span></div>' +
      '<div class="sec-label">Order summary</div>' +
      '<div class="summary-line"><span class="lbl">' + pages + ' page' + (pages === 1 ? '' : 's') + ' × ' + money(rate, pricing.currency) + '</span><span>' + money(total, pricing.currency) + '</span></div>' +
      '<div class="summary-line" style="margin-top:8px;border-color:var(--line-strong)"><span class="lbl">Total due</span><span class="amt">' + money(total, pricing.currency) + '</span></div>' +
      '</div></div>' +

      '<div class="card">' +
      '<div class="spread"><span class="sec-label" style="margin:0">Card details</span>' +
      '<span class="card-brand">{card}</span></div>' +
      '<div class="pay-field" style="margin-top:12px"><span class="lbl">Card number</span>' +
      '<input class="input" id="pay-number" inputmode="numeric" autocomplete="cc-number" placeholder="1234 5678 9012 3456" maxlength="19"></div>' +
      '<div class="pay-grid" style="margin-top:12px">' +
      '<div class="pay-field"><span class="lbl">Expiry</span>' +
      '<input class="input" id="pay-exp" inputmode="numeric" autocomplete="cc-exp" placeholder="MM/YY" maxlength="5"></div>' +
      '<div class="pay-field"><span class="lbl">CVV</span>' +
      '<input class="input" id="pay-cvv" inputmode="numeric" autocomplete="cc-csc" placeholder="123" maxlength="4" type="password"></div>' +
      '</div>' +
      '</div>' +

      '<div id="pay-result"></div>' +
      '<div style="margin-top:18px">' +
      '<button class="btn primary" id="pay-now" type="button">' + icon('card') + '<span>Pay ' + money(total, pricing.currency) + '</span></button>' +
      '</div>';

    var num = $('#pay-number', el);
    var exp = $('#pay-exp', el);
    var cvv = $('#pay-cvv', el);

    function fmtCard(v) {
      return String(v).replace(/\D/g, '').slice(0, 16).replace(/(\d{4})(?=\d)/g, '$1 ');
    }
    num.addEventListener('input', function () { num.value = fmtCard(num.value); });
    exp.addEventListener('input', function () {
      var d = String(exp.value).replace(/\D/g, '').slice(0, 4);
      exp.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d;
    });
    cvv.addEventListener('input', function () { cvv.value = String(cvv.value).replace(/\D/g, '').slice(0, 4); });

    $('#pay-now', el).addEventListener('click', function () {
      var digits = fmtCard(num.value).replace(/\s/g, '');
      var expVal = exp.value.replace(/\D/g, '');
      var ok = digits.length === 16 && expVal.length === 4 && cvv.value.length >= 3;
      var host = $('#pay-result', el);
      if (!ok) { host.innerHTML = note('Enter a card number, expiry and CVV to continue.', 'bad'); return; }
      host.innerHTML = '';

      var btn = $('#pay-now', el);
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span><span>Taking payment…</span>';
      settle(el);
    });
  }

  /*
   * The checkout is settled on the server, per document: the server recomputes
   * the price from the owner's rates and the real page count and records the
   * payment, which is what lets the job print. This demo card screen only
   * decides *that* the person agreed to pay, never how much.
   */
  function settle(el) {
    var pricing = state.printer.pricing;
    var host = $('#pay-result', el);
    var paid = [];
    var failed = [];

    function step(i, done) {
      if (i >= state.jobs.length) return done();
      api('/jobs/' + encodeURIComponent(state.jobs[i].id) + '/pay', {
        method: 'POST',
        body: { printer: state.printer.id, mode: state.mode, method: 'card' },
      }).then(function (res) {
        var payment = res && res.payment;
        if (payment) paid.push(payment);
        else failed.push('The payment was not recorded.');
        step(i + 1, done);
      }).catch(function (err) {
        failed.push(err && err.message ? err.message : 'Payment failed.');
        step(i + 1, done);
      });
    }

    step(0, function () {
      if (failed.length) {
        host.innerHTML = note(failed[0], 'bad');
        var payBtn = $('#pay-now', el);
        payBtn.disabled = false;
        payBtn.innerHTML = icon('card') + '<span>Try payment again</span>';
        return;
      }
      var total = paid.reduce(function (sum, p) { return sum + Number(p.amount || 0); }, 0);
      var pages = paid.reduce(function (sum, p) { return sum + Number(p.pages || 0); }, 0);
      state.payment = {
        currency: pricing.currency,
        perPage: perPageRate(),
        pages: pages,
        total: Math.round(total * 100) / 100,
        reference: paid.length ? paid[0].at : null,
      };
      state.paid = true;
      persist();
      host.innerHTML = note('Payment received — sending to the printer.', 'ok');
      setTimeout(function () { submitPrint(el); }, 350);
    });
  }

  /* ---------------------------------------------- printer: submit print */

  function tokenFrom(res) {
    if (res && res.ticket && res.ticket.token) return res.ticket.token;
    if (res && res.token) return res.token;
    if (res && Array.isArray(res.tickets) && res.tickets.length) {
      var last = res.tickets[res.tickets.length - 1];
      if (last && last.token) return last.token;
    }
    return null;
  }

  function submitPrint(el) {
    var s = state.settings;
    var body = {
      copies: 1,
      paper: s.paper,
      orientation: s.orientation,
      duplex: Boolean(s.duplex),
      scale: 'fit',
      color: Boolean(s.color),
      printer: state.printer.id,
      printerId: state.printer.id,
    };
    if (state.mode) body.mode = state.mode;

    var host = $('#print-result', el) || $('#pay-result', el);
    if (host) host.innerHTML = '';

    var tokens = [];
    var failed = [];

    function next(i) {
      if (i >= state.jobs.length) {
        if (tokens.length) {
          state.tokens = tokens;
          persist();
          go('token');
        } else {
          var msg = failed[0] || 'The job could not be sent to the printer.';
          if (host) { host.innerHTML = note(msg + ' No changes were made — you can try again.', 'bad'); }
          var btn = $('#settings-go', el) || $('#pay-now', el);
          if (btn) { btn.disabled = false; btn.innerHTML = icon('card') + '<span>Try again</span>'; }
        }
        return;
      }
      var job = state.jobs[i];
      api('/jobs/' + encodeURIComponent(job.id) + '/print', { method: 'POST', body: body })
        .then(function (res) {
          var token = tokenFrom(res);
          if (token) tokens.push(token);
          else failed.push('No print code was returned.');
          next(i + 1);
        })
        .catch(function (err) {
          failed.push(err && err.message ? err.message : 'Print request failed.');
          next(i + 1);
        });
    }

    var btn = $('#settings-go', el) || $('#pay-now', el);
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span><span>Sending to printer…</span>'; }
    next(0);
  }

  /* ----------------------------------------------------- printer: step token */

  function renderToken() {
    var el = $('#step-token');
    var isShop = flowOf() === 'shop';
    var primary = state.tokens[0] || '';
    var printerName = (state.printer && state.printer.name) || 'the printer';

    if (primary) rememberToken(primary, printerName);

    el.innerHTML =
      '<div class="card" style="border-color:var(--line-strong)">' +
      '<div class="token-wrap">' +
      '<span class="token-mark">' + icon('shield') + '</span>' +
      '<span class="token-label">Your print code</span>' +
      '<span class="token-code">' + esc(primary) + '</span>' +
      '<p class="token-sub">Hand this code to ' + esc(printerName) + '. It prints as the first page of your document so nobody can pick up the wrong print.</p>' +
      (state.payment && isShop
        ? '<span class="token-paid">' + icon('check') + 'Paid ' + esc(money(state.payment.total, state.payment.currency)) + '</span>'
        : '') +
      (state.tokens.length > 1
        ? '<div class="small muted">' + state.tokens.length + ' print codes issued for this batch</div>'
        : '') +
      '</div>' +
      '</div>' +

      '<div class="card">' +
      '<div class="spread"><span class="lbl sec-label" style="margin:0">Printer</span>' +
      '<span class="small" style="text-align:right">' + esc(printerName) + (state.printer ? ' · <code>' + esc(state.printer.code) + '</code>' : '') + '</span></div>' +
      '</div>' +

      '<div class="btn-row" style="margin-top:18px">' +
      '<button class="btn ghost" type="button" id="token-another">Print another</button>' +
      '<button class="btn primary" type="button" id="token-done">' + icon('check') + '<span>Done</span></button>' +
      '</div>';

    $('#token-another', el).addEventListener('click', function () {
      state.tokens = [];
      state.files = [];
      state.jobs = [];
      state.payment = null;
      persist();
      go('upload');
    });
    $('#token-done', el).addEventListener('click', function () {
      reset();
      go('code');
    });
  }

  /* ------------------------------------------------------------- router */

  var renderers = {
    code: renderCode,
    mode: renderMode,
    details: renderDetails,
    upload: renderUpload,
    settings: renderSettings,
    payment: renderPayment,
    token: renderToken,
  };

  /* A sticker's QR opens /print/?code=PP-XXXX-XXXX, so the code somebody just
   * scanned is already typed in for them. */
  function codeFromUrl() {
    try {
      return normalizeCode(new URLSearchParams(location.search).get('code') || '');
    } catch (e) { return null; }
  }

  function boot() {
    restore();

    // A new code in the URL means somebody just scanned a different printer's
    // sticker, so start that printer's flow from the top. The same code means
    // they refreshed mid-flow, and their uploaded document is still in play.
    var scanned = codeFromUrl();
    var sameFlow = Boolean(scanned && state.printer && state.printer.code === scanned);
    if (scanned && !sameFlow) {
      reset();
      go('code');
      var box = $('#code-input');
      if (box) box.value = scanned;
      submitCode(scanned);
      return;
    }

    // Reopening the tab right after printing should show the code again; hours
    // later it should start a new job, because that is what the person came for.
    var lastPrint = recentTokens()[0];
    var justPrinted = lastPrint && lastPrint.at && (Date.now() - new Date(lastPrint.at).getTime()) < 10 * 60 * 1000;
    if (state.step && state.step !== 'code' && state.tokens && state.tokens.length && justPrinted) {
      go('token');
      return;
    }
    if (state.step && state.step !== 'code' && state.printer) {
      var flow = flowOf();
      var steps = FLOWS[flow];
      var resume = steps.indexOf(state.step) !== -1 ? state.step : (flow === 'shop' ? 'mode' : 'details');
      if (resume === 'upload' && !state.jobs.length) resume = flow === 'shop' ? 'mode' : 'details';
      go(resume);
      return;
    }

    reset();
    state.step = 'code';
    persist();
    go('code');
  }

  if (document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();