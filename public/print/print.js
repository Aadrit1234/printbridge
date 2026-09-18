/* PrintBridge — the walk-up print site.
 *
 * The site behind the sticker on a printer. Somebody types the printer's code
 * (or scans its QR, which types it for them) and is walked through sending a
 * document to it. Workspace printers are free; shop printers are priced per
 * page and paid for before printing. Every print command ends in a token, and
 * that token is printed as the first page of the document so the right pages
 * go to the right person.
 *
 * One tiny SPA: no framework, no build step.
 *   • state    — one object, mirrored into sessionStorage so a refresh keeps
 *                the uploaded document (files themselves are never persisted)
 *   • steps    — code → [colour] → printer → files → settings → [payment] → token
 *   • markup   — each step is a string of HTML; the stylesheet owns the look
 *   • live     — the token's state is always asked of the server, never guessed
 *
 * The API origin comes from /config.js (window.PRINTBRIDGE_CONFIG.apiBase) and
 * every request carries the X-Device-Id header that scopes it to this phone.
 */
(function () {
  'use strict';

  var CFG = window.PRINTBRIDGE_CONFIG || {};
  var ORIGIN = String(CFG.apiBase || '').replace(/\/+$/, '');
  var BASE = ORIGIN + '/api/v1';

  var DEVICE_KEY = 'printbridge.device';
  var SESSION_KEY = 'printbridge.print.session';
  /* One theme choice across the whole product: the main site and the admin
   * console store 'light' | 'dark' | 'system' here too, so somebody who picked
   * dark on the marketing site gets a dark print site on the same origin. */
  var THEME_KEY = 'pb.theme';

  var ALLOWED_MIMES = [
    'pdf', 'jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'bmp', 'tif', 'tiff',
    'txt', 'csv', 'log', 'md', 'doc', 'docx', 'odt', 'rtf', 'ppt', 'pptx', 'xls', 'xlsx', 'ods',
  ];
  var MAX_FILES = 10;
  var CODE_LEN = 8;

  var PAPERS_ORDER = ['a4', 'letter', 'legal', 'a5'];
  var PAPER_NAMES = { a4: 'A4', letter: 'Letter', legal: 'Legal', a5: 'A5' };
  var ORIENTATION_NAMES = { portrait: 'Portrait', landscape: 'Landscape' };
  var CURRENCY_SYMBOLS = { INR: '\u20B9', USD: '$', EUR: '\u20AC', GBP: '\u00A3' };

  /* Paper size → width:height, so the preview flips with the orientation. */
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
    code: 'Printer code', mode: 'Colour', details: 'Printer', upload: 'Files',
    settings: 'Settings', payment: 'Payment', token: 'Token',
  };

  /* What a print command's state is called, in the words somebody standing at a
   * printer would use. */
  var TICKET_LABELS = {
    queued: { text: 'Queued', cls: 'grey', why: 'Waiting its turn in the printer' },
    waiting: { text: 'Waiting for printer', cls: 'warn', why: 'The printer is asleep or out of touch — it keeps trying' },
    printing: { text: 'Printing now', cls: 'on', why: 'Coming out of the printer' },
    printed: { text: 'Printed', cls: 'ok', why: 'Done — collect your pages' },
    failed: { text: 'Failed', cls: 'bad', why: 'The printer refused it — ask at the counter' },
    canceled: { text: 'Canceled', cls: 'bad', why: 'Stopped before printing' },
  };

  /* ------------------------------------------------------------- helpers */

  function $(sel, el) { return (el || document).querySelector(sel); }
  function $$(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }

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

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /* ------------------------------------------------------- device identity */

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

  /* ------------------------------------------------------------------ API */

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

  /* ---------------------------------------------------------------- state */

  var state = {
    code: null,
    printer: null,
    mode: null,                       // 'color' | 'mono' (shop only)
    settings: { paper: 'a4', orientation: 'portrait', duplex: false, color: false },
    files: [],                        // pending File objects (never persisted)
    jobs: [],                         // uploaded: { id, name, size, pageCount }
    payment: null,
    paid: false,
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
      if (!Array.isArray(state.tokens)) state.tokens = [];
      if (!Array.isArray(state.jobs)) state.jobs = [];
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
    state.paid = false;
    state.tokens = [];
    state.step = 'code';
    counted = {};
    persist();
  }

  function flowOf() { return (state.printer && state.printer.category === 'shop') ? 'shop' : 'workspace'; }
  function isShop() { return flowOf() === 'shop'; }

  function defaultSettings(printer) {
    var c = printer.capabilities || {};
    var papers = (c.papers || ['a4']).filter(function (p) { return PAPERS_ORDER.indexOf(p) !== -1; });
    var orientations = c.orientations || ['portrait', 'landscape'];
    return {
      paper: papers[0] || 'a4',
      orientation: orientations.indexOf('portrait') === -1 ? (orientations[0] || 'portrait') : 'portrait',
      duplex: false,
      color: Boolean(c.color),
    };
  }

  /* ------------------------------------------------------------- messaging */

  var toastTimer = null;

  function toast(text, kind) {
    var el = $('#toast');
    el.className = 'toast' + (kind === 'bad' ? ' bad' : kind === 'ok' ? ' ok' : '');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3600);
  }

  function note(text, kind) {
    var cls = kind === 'warn' ? ' warn' : kind === 'bad' ? ' bad' : kind === 'ok' ? ' ok' : '';
    var glyph = kind === 'ok' ? 'check' : (kind === 'warn' || kind === 'bad') ? 'warn' : 'info';
    return '<div class="note' + cls + '">' + icon(glyph) + '<span>' + text + '</span></div>';
  }

  /* ---------------------------------------------------------------- icons */

  var ICONS = {
    printer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8V4h12v4"/><rect x="3" y="8" width="18" height="8" rx="2.2"/><path d="M6.5 12h5"/><path d="M17.5 12v.01"/><path d="M9 16h6"/></svg>',
    photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="10.5" r="1.8"/><path d="m5 18 5-5 3.5 3.5L17 13l2.5 2.5"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5"/><path d="m7 9 5-4 5 4"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>',
    checkCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12.4 2.6 2.6L16 9.6"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v.01"/><path d="M12 11.5V16"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l10 17H2z"/><path d="M12 10v4"/><path d="M12 17v.01"/></svg>',
    card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/><path d="M6.5 14.5h4"/></svg>',
    colour: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="5"/><circle cx="15" cy="15" r="5"/><path d="M9 14v.01"/></svg>',
    mono: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z"/></svg>',
    page: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6"/><path d="M9 12h6"/><path d="M9 16h3"/></svg>',
    layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 8 4.5-8 4.5L4 7.5z"/><path d="m4 12 8 4.5 8-4.5"/><path d="m4 16.5 8 4.5 8-4.5"/></svg>',
    crop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v14a1 1 0 0 0 1 1h14"/><path d="M3 6h14a1 1 0 0 1 1 1v14"/></svg>',
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-3-3"/><path d="M20 16H7l3 3"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10" width="15" height="10" rx="2.4"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/></svg>',
    qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><path d="M14 14h3v3h-3z"/><path d="M20 14v.01"/><path d="M20 20v.01"/><path d="M14 20v.01"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>',
  };

  function icon(name) { return ICONS[name] || ''; }

  /* -------------------------------------------------------- shell: chrome */

  /* The strip that follows the person — the printer chip and the progress
   * ribbon — is painted from one place so it can never drift out of step. */
  function paintChrome() {
    var steps = FLOWS[flowOf()];
    var index = currentIndex();

    var pips = $('#pips');
    if (pips) {
      pips.innerHTML = steps.map(function (key, i) {
        var cls = i < index ? 'done' : i === index ? 'current' : '';
        return '<li class="pip ' + cls + '">' +
          '<span class="pip-bar"><i></i></span>' +
          '<span class="pip-name">' + esc(STEP_LABELS[key]) + '</span>' +
          '</li>';
      }).join('');
    }

    var progress = $('#progress');
    if (progress) progress.hidden = state.step === 'code';

    var count = $('#progress-count');
    if (count) count.textContent = 'Step ' + (index + 1) + ' of ' + steps.length;

    var name = $('#progress-name');
    if (name) name.textContent = STEP_LABELS[state.step] || '';

    var code = $('#progress-printer');
    if (code) code.textContent = state.printer ? String(state.printer.code || '') : '';

    var chip = $('#printer-chip');
    if (chip) {
      chip.hidden = !state.printer;
      if (state.printer) {
        $('#chip-name').textContent = state.printer.name || 'Printer';
        $('#chip-code').textContent = String(state.printer.code || '');
        chip.classList.toggle('off', state.printer.active === false);
      }
    }

    var foot = $('#foot');
    if (foot) {
      foot.innerHTML = state.printer
        ? 'Every print command gets its own token, printed on top of your document.'
        : 'Type the code from the sticker on the printer you are standing at. It is free for workspace printers.';
    }
  }

  /* ------------------------------------------------- routing + progress */

  function currentIndex() {
    var idx = FLOWS[flowOf()].indexOf(state.step);
    return idx === -1 ? 0 : idx;
  }

  function go(key) {
    var steps = FLOWS[flowOf()];
    if (steps.indexOf(key) === -1) key = 'code';
    state.step = key;
    persist();

    $$('.stage').forEach(function (stage) { stage.classList.remove('active'); });
    var target = $('#step-' + key);
    if (target) {
      target.hidden = false;
      target.classList.add('active');
    }
    paintChrome();
    renderers[key]();
    document.body.classList.toggle('wide', key === 'settings' || key === 'payment');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ======================================================== step: the code */

  function normalizeCode(value) {
    var raw = String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (raw.slice(0, 2) === 'PP') raw = raw.slice(2);
    if (raw.length !== CODE_LEN) return null;
    return 'PP-' + raw.slice(0, 4) + '-' + raw.slice(4);
  }

  function codeBody(value) {
    var raw = String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (raw.slice(0, 2) === 'PP') raw = raw.slice(2);
    return raw.slice(0, CODE_LEN);
  }

  function normalizeToken(value) {
    var raw = String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (raw.slice(0, 2) === 'PB') raw = raw.slice(2);
    if (raw.length !== CODE_LEN) return null;
    return 'PB-' + raw.slice(0, 4) + '-' + raw.slice(4);
  }

  function codesFromUrl() {
    try { return normalizeCode(new URLSearchParams(location.search).get('code') || ''); } catch (e) { return null; }
  }

  function renderCode() {
    var el = $('#step-code');

    var cells = '';
    for (var i = 0; i < CODE_LEN; i++) {
      if (i === 4) cells += '<span class="code-dash" aria-hidden="true"></span></div><div class="code-group">';
      cells += '<input class="code-cell" data-i="' + i + '" type="text" inputmode="text" maxlength="1" ' +
        'autocomplete="off" autocapitalize="characters" spellcheck="false" ' +
        'aria-label="Code character ' + (i + 1) + '" data-1p-ignore data-lpignore="true">';
    }

    el.innerHTML =
      '<div class="hero">' +
      '<span class="hero-badge" aria-hidden="true">' + icon('printer') + '</span>' +
      '<h1 id="h-code">Print from <span class="grad">this printer</span></h1>' +
      '<p class="lead">' +
      (state.printer
        ? 'Type a different code, or carry on with ' + esc(state.printer.name) + '.'
        : 'Enter the code on the sticker attached to the printer you are standing at. We look it up and set everything else up for you.') +
      '</p>' +
      '</div>' +

      '<div class="panel code-panel">' +
      '<form class="code-form" id="code-form" novalidate>' +
      '<label class="opt-label" for="code-cell-0">Printer code</label>' +
      '<div class="code-boxes" id="code-boxes">' +
      '<div class="code-group">' + cells + '</div>' +
      '</div>' +
      '<p class="code-hint">Eight characters, in two blocks of four. No letter looks like <b>0</b>, <b>O</b>, <b>1</b> or <b>I</b> — so anything you type is a real code.</p>' +
      '<button class="btn go lg wide" type="submit" id="code-go">' + icon('bolt') + '<span class="lbl">Find this printer</span></button>' +
      '<div class="code-result" id="code-result"></div>' +
      '</form>' +
      '</div>' +

      '<div class="scan-hint" style="margin-top:16px">' + icon('qr') +
      '<span>Scanning the sticker\'s QR opens this page with the code already filled in — you never have to type it.</span></div>';

    var boxes = $('#code-boxes', el);
    var inputs = $$('.code-cell', el);
    var submit = $('#code-go', el);

    function paintCell(cell) {
      cell.classList.toggle('filled', Boolean(cell.value));
    }

    function clearError() {
      boxes.classList.remove('shake');
      var host = $('#code-result', el);
      if (host) host.innerHTML = '';
    }

    function codeValue() {
      return inputs.map(function (c) { return c.value; }).join('');
    }

    function setReady() {
      var full = codeValue().length === CODE_LEN;
      submit.classList.toggle('ready', full);
      return full;
    }

    function write(from, text) {
      var chars = codeBody(text).split('');
      for (var i = 0; i < chars.length && from + i < inputs.length; i++) {
        inputs[from + i].value = chars[i];
        paintCell(inputs[from + i]);
      }
      var next = Math.min(from + chars.length, inputs.length - 1);
      inputs[next].focus();
      clearError();
      setReady();
    }

    inputs.forEach(function (cell, i) {
      var label = cell.getAttribute('aria-label');
      if (label) cell.id = 'code-cell-' + i;

      cell.addEventListener('input', function () {
        var typed = cell.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
        if (!typed) { cell.value = ''; paintCell(cell); setReady(); return; }
        cell.value = '';
        write(i, typed);
      });

      cell.addEventListener('keydown', function (event) {
        if (event.key === 'Backspace' && !cell.value && i > 0) {
          event.preventDefault();
          inputs[i - 1].value = '';
          paintCell(inputs[i - 1]);
          inputs[i - 1].focus();
          setReady();
          return;
        }
        if (event.key === 'ArrowLeft' && i > 0) { event.preventDefault(); inputs[i - 1].focus(); }
        if (event.key === 'ArrowRight' && i < inputs.length - 1) { event.preventDefault(); inputs[i + 1].focus(); }
        if (event.key === 'Enter') { event.preventDefault(); submitCode(); }
      });

      cell.addEventListener('focus', function () { try { cell.select(); } catch (e) { /* fine */ } });

      cell.addEventListener('paste', function (event) {
        var clip = (event.clipboardData || window.clipboardData);
        if (!clip) return;
        event.preventDefault();
        write(0, clip.getData('text') || '');
      });
    });

    if (state.printer && state.step === 'code') {
      write(0, codeBody(state.printer.code || ''));
      inputs[inputs.length - 1].focus();
      setReady();
    } else {
      inputs[0].focus();
    }

    $('#code-form', el).addEventListener('submit', function (event) {
      event.preventDefault();
      submitCode();
    });
  }

  function submitCode(explicit) {
    var el = $('#step-code');
    var inputs = $$('.code-cell', el);
    var typed = explicit || inputs.map(function (c) { return c.value; }).join('');
    var code = normalizeCode(typed);
    var boxes = $('#code-boxes', el);
    var host = $('#code-result', el);
    var button = $('#code-go', el);

    if (!code) {
      toast('A printer code is eight characters, like PP-7K4Q-2M9D', 'bad');
      if (boxes) {
        boxes.classList.remove('shake');
        void boxes.offsetWidth;
        boxes.classList.add('shake');
      }
      var firstEmpty = inputs.filter(function (c) { return !c.value; })[0] || inputs[0];
      if (firstEmpty) firstEmpty.focus();
      return;
    }

    host.innerHTML = note('Looking up <b>' + esc(code) + '</b>…');
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span><span class="lbl">Looking it up…</span>';

    function fail(message) {
      host.innerHTML = note(esc(message), 'bad');
      button.disabled = false;
      button.innerHTML = icon('bolt') + '<span class="lbl">Find this printer</span>';
      if (boxes) {
        boxes.classList.remove('shake');
        void boxes.offsetWidth;
        boxes.classList.add('shake');
      }
    }

    api('/printers/' + encodeURIComponent(code))
      .then(function (res) {
        var printer = res && res.printer;
        if (!printer) throw new ApiError('No printer details came back.');
        state.code = printer.code || code;
        state.printer = printer;
        state.settings = defaultSettings(printer);
        state.mode = null;
        state.jobs = [];
        state.tokens = [];
        state.paid = false;
        state.payment = null;
        state.step = printer.category === 'shop' ? 'mode' : 'details';
        persist();
        go(state.step);
      })
      .catch(function (err) {
        fail(err && err.status === 404
          ? 'No printer has that code. Check the sticker and try again.'
          : (err.message || 'Could not reach the print server.'));
      });
  }

  /* ================================================ step: colour or mono */

  function renderMode() {
    var el = $('#step-mode');
    var printer = state.printer;
    var pricing = printer && printer.pricing;
    var colourCapable = Boolean(printer && printer.capabilities && printer.capabilities.color);
    if (!printer) { reset(); return go('code'); }
    if (!pricing) { toast('This printer has no prices set yet.', 'bad'); reset(); return go('code'); }

    var cheapest = Number(pricing.monoPerPage) <= Number(pricing.colorPerPage) ? 'mono' : 'color';

    el.innerHTML =
      '<div class="stage-head">' +
      '<div class="eyebrow">' + esc(printer.name) + ' · priced per page</div>' +
      '<h1 class="display">Colour or <span class="grad">black &amp; white</span>?</h1>' +
      '<p class="lead">This is a shop printer, so you pay for what comes out of it. Pick now — the choice is locked in for this job.</p>' +
      '</div>' +

      '<div class="modes">' +
      '<button type="button" class="mode colour" data-mode="color"' + (colourCapable ? '' : ' disabled') + '>' +
      '<span class="mode-icon">' + icon('colour') + '</span>' +
      '<span class="mode-name">Colour</span>' +
      '<span class="mode-rate"><b>' + esc(money(pricing.colorPerPage, pricing.currency)) + '</b> per page</span>' +
      '<span class="mode-note">' + (colourCapable ? 'Photos, posters, anything with colour in it' : 'This printer prints in black & white only') + '</span>' +
      '</button>' +
      '<button type="button" class="mode mono" data-mode="mono">' +
      '<span class="mode-icon">' + icon('mono') + '</span>' +
      '<span class="mode-name">Black &amp; white</span>' +
      '<span class="mode-rate"><b>' + esc(money(pricing.monoPerPage, pricing.currency)) + '</b> per page</span>' +
      '<span class="mode-note">' + (cheapest === 'mono' ? 'Cheapest — documents, contracts, forms' : 'Documents, forms, anything typed') + '</span>' +
      '</button>' +
      '</div>' +

      '<div style="margin-top:16px">' +
      note('The page count comes from your own document as it uploads, and the server works the total out again before it takes payment.', 'info') +
      '</div>';

    $$('.mode', el).forEach(function (tile) {
      tile.addEventListener('click', function () {
        state.mode = tile.getAttribute('data-mode');
        state.settings.color = state.mode === 'color';
        persist();
        go('details');
      });
    });
  }

  /* ===================================================== step: the printer */

  function capabilityItems(printer) {
    var c = printer.capabilities || {};
    var papers = (c.papers || []).map(function (p) { return PAPER_NAMES[p] || String(p).toUpperCase(); });
    var orientations = (c.orientations || []).map(function (o) { return ORIENTATION_NAMES[o] || cap(o); });
    var items = [
      { icon: 'page', title: papers.join(' · ') || 'A4', sub: 'Paper sizes' },
      { icon: 'crop', title: orientations.join(' · ') || 'Portrait', sub: 'Direction' },
      { icon: 'layers', title: c.duplex ? 'Both sides' : 'Single-sided', sub: 'Double-sided' },
      { icon: c.color ? 'colour' : 'mono', title: c.color ? 'Colour' : 'Black & white', sub: 'Ink' },
    ];
    return '<div class="caps">' + items.map(function (item) {
      return '<div class="cap"><span class="cap-icon">' + icon(item.icon) + '</span>' +
        '<span class="cap-text"><b>' + esc(item.title) + '</b><em>' + esc(item.sub) + '</em></span></div>';
    }).join('') + '</div>';
  }

  function renderDetails() {
    var el = $('#step-details');
    var printer = state.printer;
    if (!printer) { toast('Printer context lost — enter the code again.', 'bad'); reset(); return go('code'); }

    var shop = printer.category === 'shop';
    var pricing = printer.pricing || null;
    var paused = printer.active === false;

    var modeLine = '';
    if (shop && state.mode && pricing) {
      var rate = state.mode === 'color' ? pricing.colorPerPage : pricing.monoPerPage;
      modeLine =
        '<div class="mode-locked" style="margin-top:14px">' +
        '<span class="cap-icon">' + icon(state.mode === 'color' ? 'colour' : 'mono') + '</span>' +
        '<span class="grow"><b>' + (state.mode === 'color' ? 'Colour' : 'Black &amp; white') + '</b>' +
        '<span class="small muted">' + esc(money(rate, pricing.currency)) + ' per page · chosen before uploading</span></span>' +
        '<button type="button" class="btn sm quiet" id="mode-change">Change</button>' +
        '</div>';
    }

    el.innerHTML =
      '<div class="stage-head">' +
      '<div class="eyebrow">' + (shop ? 'Step 3 · the machine' : 'Step 2 · the machine') + '</div>' +
      '<h1 class="display">' + (paused ? 'This printer is <span class="grad">paused</span>' : 'You are printing to <span class="grad">' + esc(printer.name) + '</span>') + '</h1>' +
      '<p class="lead">' + (paused
        ? 'The owner has taken it off the network for now. Try again later, or use a different printer.'
        : 'Check it is the right machine, then add your document. Nothing is charged until you press print.') + '</p>' +
      '</div>' +

      '<div class="panel">' +
      '<div class="machine' + (paused ? ' off' : '') + '">' +
      '<span class="machine-ring" aria-hidden="true">' + icon('printer') + '</span>' +
      '<span class="grow"><span class="machine-name">' + esc(printer.name) + '</span>' +
      '<span class="machine-code">' + esc(printer.code) + '</span></span>' +
      '<span class="chip ' + (paused ? 'bad' : 'ok') + '">' + (paused ? 'Paused' : 'Ready') + '</span>' +
      '</div>' +
      (printer.note ? '<p class="small muted" style="margin-top:12px">' + esc(printer.note) + '</p>' : '') +
      '<div class="group-label">What this printer can do</div>' +
      capabilityItems(printer) +
      modeLine +
      '</div>' +

      '<div class="stack" style="margin-top:16px">' +
      '<button class="btn go lg wide" type="button" id="details-go"' + (paused ? ' disabled' : '') + '>' +
      icon('upload') + '<span class="lbl">' + (paused ? 'Unavailable right now' : 'Add your documents') + '</span></button>' +
      '<button class="btn quiet wide" type="button" id="other-printer">' + icon('swap') + '<span class="lbl">Use a different printer</span></button>' +
      '</div>';

    var change = $('#mode-change', el);
    if (change) change.addEventListener('click', function () { go('mode'); });
    $('#details-go', el).addEventListener('click', function () { go('upload'); });
    $('#other-printer', el).addEventListener('click', function () {
      state.printer = null;
      state.code = null;
      state.jobs = [];
      persist();
      go('code');
    });
  }

  /* ======================================================= step: documents */

  function fileExt(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function renderUpload() {
    var el = $('#step-upload');
    var shop = isShop();

    el.innerHTML =
      '<div class="stage-head">' +
      '<div class="eyebrow">Up to ' + MAX_FILES + ' files at a time</div>' +
      '<h1 class="display">Add your <span class="grad">document</span></h1>' +
      '<p class="lead">' + (shop
        ? 'Anything on the list. Your total is worked out from the pages as they arrive.'
        : 'PDF, photos, Office documents, plain text — anything on the list prints. Nothing leaves your phone until you upload it.') + '</p>' +
      '</div>' +

      '<div class="panel">' +
      '<div class="drop" id="dropzone" tabindex="0" role="button" aria-label="Choose files">' +
      '<span class="drop-icon">' + icon('upload') + '</span>' +
      '<span class="drop-title">Tap to choose files</span>' +
      '<span class="drop-sub">or drop them anywhere in this box</span>' +
      '<span class="drop-types">PDF · Images · Office · Text</span>' +
      '<input type="file" id="file-input" multiple accept="' + ALLOWED_MIMES.map(function (m) { return '.' + m; }).join(',') + '">' +
      '</div>' +
      '<div class="meter" id="meter">' +
      '<span class="meter-text" id="meter-text">0 added</span>' +
      '<span class="meter-track"><i class="meter-fill" id="meter-fill"></i></span>' +
      '<span class="meter-text nowrap">' + MAX_FILES + ' max</span>' +
      '</div>' +
      '<div class="files" id="file-list"></div>' +
      (shop
        ? '<div class="estimate hidden" id="upload-estimate"><span id="upload-est-title">Estimated total</span><b id="upload-est-amt"></b></div>'
        : '') +
      '<div id="file-note" style="margin-top:14px"></div>' +
      '</div>' +

      '<div class="stack" style="margin-top:16px">' +
      '<button class="btn go lg wide" type="button" id="upload-go" disabled>' + icon('upload') + '<span class="lbl">Upload &amp; continue</span></button>' +
      '<button class="btn quiet wide hidden" type="button" id="upload-again">Add more files</button>' +
      '</div>';

    var input = $('#file-input', el);
    var dz = $('#dropzone', el);
    var list = $('#file-list', el);

    function paintFiles() {
      list.innerHTML = state.files.map(function (f, i) {
        return '<div class="file" style="--i:' + i + '">' +
          '<span class="file-num">' + (i + 1) + '</span>' +
          '<span class="file-body">' +
          '<span class="file-name">' + esc(f.name) + '</span>' +
          '<span class="file-sub">' + fmtBytes(f.size) + ' · ' + esc((fileExt(f.name) || 'file').toUpperCase()) + '</span>' +
          '</span>' +
          '<button type="button" class="file-x" data-i="' + i + '" aria-label="Remove ' + esc(f.name) + '">' + icon('warn') + '</button>' +
          '</div>';
      }).join('');

      var goBtn = $('#upload-go', el);
      var count = state.files.length;
      goBtn.disabled = count === 0;
      goBtn.querySelector('.lbl').textContent = count
        ? 'Upload ' + plural(count, 'file') + ' & continue'
        : 'Upload & continue';

      var fill = $('#meter-fill', el);
      if (fill) fill.style.width = Math.round((count / MAX_FILES) * 100) + '%';
      var meterText = $('#meter-text', el);
      if (meterText) meterText.textContent = count ? plural(count, 'file') + ' added' : 'Nothing added yet';

      var more = $('#upload-again', el);
      more.classList.toggle('hidden', count === 0 || count >= MAX_FILES);
    }

    function addFiles(fileList) {
      var incoming = Array.prototype.slice.call(fileList || []);
      var room = MAX_FILES - state.files.length;
      if (incoming.length > room) {
        toast('Up to ' + MAX_FILES + ' files at a time — ' + (incoming.length - room) + ' left out.', 'bad');
        incoming = incoming.slice(0, room);
      }
      for (var i = 0; i < incoming.length; i++) {
        if (ALLOWED_MIMES.indexOf(fileExt(incoming[i].name)) === -1) {
          toast(incoming[i].name + ' is not a supported file type.', 'bad');
          continue;
        }
        state.files.push(incoming[i]);
      }
      paintFiles();
    }

    input.addEventListener('change', function () {
      addFiles(input.files);
      input.value = '';
    });

    dz.addEventListener('click', function () { input.click(); });
    dz.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
    });

    var dragCount = 0;
    dz.addEventListener('dragenter', function (e) { e.preventDefault(); dragCount++; dz.classList.add('dragging'); });
    dz.addEventListener('dragover', function (e) { e.preventDefault(); });
    dz.addEventListener('dragleave', function () { dragCount--; if (dragCount <= 0) dz.classList.remove('dragging'); });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      dragCount = 0;
      dz.classList.remove('dragging');
      var data = e.dataTransfer && e.dataTransfer.files;
      if (data && data.length) addFiles(data);
    });

    list.addEventListener('click', function (e) {
      var btn = e.target.closest('.file-x');
      if (!btn) return;
      state.files.splice(Number(btn.getAttribute('data-i')), 1);
      paintFiles();
    });

    $('#upload-again', el).addEventListener('click', function () { input.click(); });
    $('#upload-go', el).addEventListener('click', function () { uploadFiles(el); });

    paintFiles();
    renderEstimate();
    refreshFileCounts();
  }

  function uploadFiles(el) {
    if (!state.files.length) return;
    var form = new FormData();
    for (var i = 0; i < state.files.length; i++) {
      form.append('files', state.files[i], state.files[i].name);
    }

    // Careful: this used to be called `go`, which shadowed the step router.
    var goBtn = $('#upload-go', el);
    goBtn.disabled = true;
    goBtn.innerHTML = '<span class="spinner"></span><span class="lbl">Uploading…</span>';
    var host = $('#file-note', el);
    host.innerHTML = '';

    api('/jobs', { method: 'POST', form: form })
      .then(function (res) {
        var jobs = (res && res.jobs) || [];
        var errors = (res && res.errors) || [];
        if (!jobs.length) {
          var firstError = (errors[0] && errors[0].error) || 'The files could not be uploaded.';
          host.innerHTML = note(esc(firstError), 'bad');
          goBtn.disabled = false;
          goBtn.innerHTML = icon('upload') + '<span class="lbl">Try again</span>';
          return;
        }
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
        host.innerHTML = note(plural(jobs.length, 'file') + ' uploaded' +
          (errors.length ? ', ' + errors.length + ' left out' : '') + '.', 'ok');
        goBtn.disabled = false;
        goBtn.querySelector('.lbl').textContent = 'Continue to settings';
        setTimeout(function () { go('settings'); }, 620);
      })
      .catch(function (err) {
        host.innerHTML = note(esc(err.message || 'Upload failed — try again.'), 'bad');
        goBtn.disabled = false;
        goBtn.innerHTML = icon('upload') + '<span class="lbl">Try again</span>';
      });
  }

  /* Page counts are worked out by the server as each document is prepared, so
   * a shop total is never a guess. Every step that shows money asks again —
   * but any one job is only asked about once, so this can never spin. */
  var counted = {};

  function syncPageCounts(then) {
    var pending = state.jobs.filter(function (job) {
      return !job.pageCount && !counted[job.id];
    });
    if (!pending.length) return then(false);
    pending.forEach(function (job) { counted[job.id] = true; });
    Promise.all(pending.map(function (job) {
      return api('/files/' + encodeURIComponent(job.id) + '/meta')
        .then(function (meta) {
          var pages = meta && Number(meta.pageCount);
          if (pages) job.pageCount = pages;
        })
        .catch(function () { /* leave it as "counting" */ });
    })).then(function () {
      var changed = pending.some(function (job) { return job.pageCount; });
      if (changed) persist();
      then(changed);
    });
  }

  /* Best-effort on arrival: the person is still reading, so fetch quietly. */
  function refreshFileCounts() {
    if (!state.jobs.length) return;
    setTimeout(function () {
      syncPageCounts(function (changed) {
        if (changed) renderEstimate();
      });
    }, 2200);
  }

  function estimatePages() {
    return state.jobs.reduce(function (sum, job) { return sum + (job.pageCount || 1); }, 0);
  }

  function perPageRate() {
    var pricing = state.printer && state.printer.pricing;
    if (!pricing || !state.mode) return null;
    return Number(state.mode === 'color' ? pricing.colorPerPage : pricing.monoPerPage);
  }

  function renderEstimate() {
    var pricing = state.printer && state.printer.pricing;
    var rate = perPageRate();
    var box = $('#upload-estimate');
    if (!box) return;
    if (!pricing || !rate) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    var allCounted = state.jobs.length && state.jobs.every(function (job) { return job.pageCount; });
    if (!allCounted) {
      // Page counts arrive from the server as each document is prepared, so
      // show that rather than a confident "₹0".
      $('#upload-est-title').textContent = state.jobs.length ? 'Counting pages…' : 'Nothing to count yet';
      $('#upload-est-amt').textContent = state.jobs.length ? '—' : '';
      return;
    }
    var pages = estimatePages();
    $('#upload-est-title').textContent = plural(pages, 'page') + ' × ' + money(rate, pricing.currency);
    $('#upload-est-amt').textContent = '≈ ' + money(Math.round(pages * rate * 100) / 100, pricing.currency);
  }

  /* ======================================================== step: settings */

  function segmented(id, values, names, current) {
    return '<div class="seg" id="' + id + '">' + values.map(function (value) {
      return '<button type="button" class="seg-btn' + (value === current ? ' on' : '') + '" data-value="' + esc(value) + '">' +
        esc(names[value] || cap(value)) + '</button>';
    }).join('') + '</div>';
  }

  function bindSeg(root, id, onChange) {
    var seg = $('#' + id, root);
    if (!seg) return;
    seg.addEventListener('click', function (event) {
      var btn = event.target.closest('.seg-btn');
      if (!btn || btn.disabled) return;
      $$('.seg-btn', seg).forEach(function (other) { other.classList.remove('on'); });
      btn.classList.add('on');
      onChange(btn.getAttribute('data-value'));
    });
  }

  function renderSettings() {
    var el = $('#step-settings');
    var printer = state.printer;
    if (!printer) { toast('Printer context lost — enter the code again.', 'bad'); reset(); return go('code'); }

    var c = printer.capabilities || {};
    var shop = isShop();
    var s = state.settings;

    var papers = (c.papers || []).filter(function (p) { return PAPERS_ORDER.indexOf(p) !== -1; })
      .sort(function (a, b) { return PAPERS_ORDER.indexOf(a) - PAPERS_ORDER.indexOf(b); });
    if (!papers.length) papers = ['a4'];
    if (papers.indexOf(s.paper) === -1) s.paper = papers[0];

    var orientations = (c.orientations || ['portrait', 'landscape']);
    if (!orientations.length) orientations = ['portrait'];
    if (orientations.indexOf(s.orientation) === -1) s.orientation = orientations[0];

    var colourRow;
    if (shop) {
      colourRow =
        '<div class="switch-row">' +
        '<span class="switch-text"><span>' + (state.mode === 'color' ? 'Colour' : 'Black &amp; white') + '</span>' +
        '<em>Chosen before uploading — locked for this job</em></span>' +
        '<span class="chip on">' + icon('lock') + 'Locked</span>' +
        '</div>';
    } else if (c.color) {
      colourRow =
        '<div class="switch-row">' +
        '<span class="switch-text"><span>Colour printing</span><em>This printer can print in colour</em></span>' +
        '<label class="switch"><input type="checkbox" id="set-color"' + (s.color ? ' checked' : '') + '><span class="track"></span></label>' +
        '</div>';
    } else {
      colourRow =
        '<div class="switch-row">' +
        '<span class="switch-text"><span>Colour printing</span><em>Not available — this machine is monochrome</em></span>' +
        '<label class="switch"><input type="checkbox" disabled><span class="track"></span></label>' +
        '</div>';
    }

    var duplexRow = c.duplex
      ? '<div class="switch-row">' +
        '<span class="switch-text"><span>Print on both sides</span><em>Saves paper — the machine flips the sheet itself</em></span>' +
        '<label class="switch"><input type="checkbox" id="set-duplex"' + (s.duplex ? ' checked' : '') + '><span class="track"></span></label>' +
        '</div>'
      : '<div class="switch-row">' +
        '<span class="switch-text"><span>Print on both sides</span><em>Not available — this machine is single-sided</em></span>' +
        '<label class="switch"><input type="checkbox" disabled><span class="track"></span></label>' +
        '</div>';

    var rate = shop ? perPageRate() : null;

    function summaryHtml() {
      if (!shop || rate == null) return '';
      var pages = estimatePages();
      var total = Math.round(pages * rate * 100) / 100;
      var currency = printer.pricing.currency;
      return '<div class="summary">' +
        '<div class="line"><span>' + plural(pages, 'page') + ' × ' + esc(money(rate, currency)) + '</span><b>' + esc(money(total, currency)) + '</b></div>' +
        '<div class="line total"><span>Due at checkout</span><span class="amt">' + esc(money(total, currency)) + '</span></div>' +
        '</div>';
    }

    el.innerHTML =
      '<div class="stage-head">' +
      '<div class="eyebrow">' + esc(printer.name) + '</div>' +
      '<h1 class="display">How should it <span class="grad">come out</span>?</h1>' +
      '<p class="lead tight">Only what this printer can actually do is offered here.</p>' +
      '</div>' +

      '<div class="settings">' +
      '<div class="preview">' +
      '<div class="preview-head"><span>Preview</span><span id="preview-tag"></span></div>' +
      '<div class="preview-stage">' +
      '<div class="sheets" id="sheets">' +
      '<div class="sheet-doc" id="sheet-doc">' +
      '<span class="mock-title" id="mock-title"></span>' +
      '<span class="mock-line"></span><span class="mock-line semi"></span><span class="mock-line"></span>' +
      '<span class="mock-line semi"></span><span class="mock-line short"></span>' +
      '<span class="mock-tag" id="mock-tag"></span>' +
      '</div>' +
      '<div class="sheet-token" id="sheet-token">' +
      '<span class="tok-label">TOKEN</span>' +
      '<span class="tok-code">PB-••••-••••</span>' +
      '<span class="mock-line short"></span><span class="mock-line"></span><span class="mock-line short"></span>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<p class="small muted">The token page prints in front of your document, so nobody picks up the wrong pages.</p>' +
      '</div>' +

      '<div class="controls">' +
      '<div class="panel tight">' +
      '<div class="group-label first">Paper</div>' +
      segmented('set-paper', papers, PAPER_NAMES, s.paper) +
      '<div class="group-label">Direction</div>' +
      segmented('set-orientation', orientations, ORIENTATION_NAMES, s.orientation) +
      (orientations.length < 2 ? '<p class="small muted" style="margin-top:8px">This printer only feeds one way.</p>' : '') +
      '<div class="group-label">Options</div>' +
      duplexRow + colourRow +
      '<div id="summary-host">' + summaryHtml() + '</div>' +
      '</div>' +
      '</div>' +
      '</div>' +

      '<div class="stack" style="margin-top:16px">' +
      '<button class="btn go lg wide" type="button" id="settings-go">' +
      icon('printer') + '<span class="lbl">' + (shop ? 'Continue to payment' : 'Print now') + '</span></button>' +
      '</div>' +
      '<div id="print-result" style="margin-top:12px"></div>';

    function paintPreview(animate) {
      var doc = $('#sheet-doc', el);
      var token = $('#sheet-token', el);
      var sheets = $('#sheets', el);
      var ratio = SHEET_RATIOS[s.paper] || SHEET_RATIOS.a4;
      var portrait = s.orientation !== 'landscape';
      var width = portrait ? 150 : 208;
      var height = Math.round(width / (portrait ? ratio.portrait : ratio.landscape));

      if (doc) { doc.style.width = width + 'px'; doc.style.height = height + 'px'; }
      if (token) {
        var tw = Math.max(78, Math.round(width * 0.34));
        token.style.width = tw + 'px';
        token.style.height = Math.round(tw * 1.38) + 'px';
      }
      var title = $('#mock-title', el);
      if (title) title.className = 'mock-title' + ((s.color || state.mode === 'color') ? ' colour' : ' bw');
      var tag = $('#mock-tag', el);
      if (tag) tag.textContent = (PAPER_NAMES[s.paper] || String(s.paper).toUpperCase()) + ' · ' + (portrait ? 'TALL' : 'WIDE');
      var previewTag = $('#preview-tag', el);
      if (previewTag) {
        previewTag.textContent = cap(s.orientation) + (s.duplex ? ' · two sides' : ' · one side');
      }
      if (animate && sheets) {
        sheets.classList.remove('flip');
        void sheets.offsetWidth;
        sheets.classList.add('flip');
      }
    }

    bindSeg(el, 'set-paper', function (value) { s.paper = value; persist(); paintPreview(true); });
    bindSeg(el, 'set-orientation', function (value) { s.orientation = value; persist(); paintPreview(true); });

    var duplex = $('#set-duplex', el);
    if (duplex) duplex.addEventListener('change', function (e) { s.duplex = e.target.checked; persist(); paintPreview(true); });
    var colour = $('#set-color', el);
    if (colour) colour.addEventListener('change', function (e) { s.color = e.target.checked; persist(); paintPreview(true); });

    $('#settings-go', el).addEventListener('click', function () {
      if (shop) go('payment');
      else submitPrint(el, $('#settings-go', el));
    });

    paintPreview(false);

    // The page count decides the price, so the total on screen has to be the
    // server's count, not this phone's guess.
    if (shop) {
      syncPageCounts(function (changed) {
        var host = $('#summary-host', el);
        if (changed && host) host.innerHTML = summaryHtml();
      });
    }
  }

  /* ========================================================= step: payment */

  function renderPayment() {
    var el = $('#step-payment');
    var pricing = state.printer && state.printer.pricing;
    var rate = perPageRate();
    if (!pricing || rate == null) { toast('Pricing is missing for this printer.', 'bad'); reset(); return go('code'); }

    var pages = estimatePages();
    var total = Math.round(pages * rate * 100) / 100;
    var currency = pricing.currency;
    var counting = state.jobs.some(function (job) { return !job.pageCount; });

    // Nobody is asked for money against a guess: if the real page count has not
    // arrived yet, ask once more, then redraw this screen with the right total.
    if (counting) {
      syncPageCounts(function (changed) { if (changed) go('payment'); });
    }

    el.innerHTML =
      '<div class="stage-head">' +
      '<div class="eyebrow">' + esc(state.printer.name) + '</div>' +
      '<h1 class="display">Pay for your <span class="grad">pages</span></h1>' +
      '<p class="lead tight">The printer only runs once this is settled. The total is confirmed by the server before anything is sent.</p>' +
      '</div>' +

      '<div class="pay">' +
      '<div class="panel tight">' +
      '<div class="cc" id="cc">' +
      '<div class="cc-top">' +
      '<span class="cc-brand">PrintBridge Pay</span>' +
      '<span class="cc-demo">Demo · no charge</span>' +
      '<span class="cc-chip" aria-hidden="true"></span>' +
      '</div>' +
      '<div class="cc-num" id="cc-num">4242 4242 4242 4242</div>' +
      '<div class="cc-row">' +
      '<span><em>Card holder</em><b>' + esc(state.printer.name) + '</b></span>' +
      '<span><em>Expires</em><b id="cc-exp">MM/YY</b></span>' +
      '</div>' +
      '</div>' +

      '<div class="fields">' +
      '<div class="field full"><label for="pay-number">Card number</label>' +
      '<input class="input mono" id="pay-number" inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242" maxlength="19"></div>' +
      '<div class="field"><label for="pay-exp">Expiry</label>' +
      '<input class="input mono" id="pay-exp" inputmode="numeric" autocomplete="cc-exp" placeholder="MM/YY" maxlength="5"></div>' +
      '<div class="field"><label for="pay-cvv">CVV</label>' +
      '<input class="input mono" id="pay-cvv" inputmode="numeric" autocomplete="cc-csc" placeholder="123" maxlength="4" type="password"></div>' +
      '</div>' +

      '<div id="pay-result" style="margin-top:14px"></div>' +
      '<div class="stack" style="margin-top:16px">' +
      '<button class="btn go lg wide" type="button" id="pay-now">' + icon('card') + '<span class="lbl">Pay ' + esc(money(total, currency)) + '</span></button>' +
      '<button class="btn quiet wide" type="button" id="pay-back">' + icon('swap') + '<span class="lbl">Back to settings</span></button>' +
      '</div>' +
      '<div class="demo-hint">' + icon('shield') +
      '<span>Demonstration checkout: nothing is charged and no card details leave this page. A real shop would settle at the counter.</span></div>' +
      '</div>' +

      '<div class="panel tight order">' +
      '<span class="opt-label">Order summary</span>' +
      '<div class="summary" style="margin-top:10px;border-top:0;padding-top:0">' +
      '<div class="line"><span>' + esc(state.printer.name) + '</span><span class="chip ' + (state.mode === 'color' ? 'on' : 'grey') + '">' +
      (state.mode === 'color' ? 'Colour' : 'Black &amp; white') + '</span></div>' +
      '<div class="line"><span>' + plural(state.jobs.length, 'document') + '</span><b>' + plural(pages, 'page') + '</b></div>' +
      '<div class="line"><span>' + plural(pages, 'page') + ' × ' + esc(money(rate, currency)) + '</span><b>' + esc(money(total, currency)) + '</b></div>' +
      '<div class="line total"><span>Total due</span><span class="amt">' + esc(money(total, currency)) + '</span></div>' +
      '</div>' +
      (counting
        ? note('Still counting the pages of your documents — the total updates by itself in a moment.', 'info')
        : '<p class="small muted" style="margin-top:12px">The server re-checks the page count before printing. A demo checkout cannot be refunded.</p>') +
      '</div>' +
      '</div>';

    var num = $('#pay-number', el);
    var exp = $('#pay-exp', el);
    var cvv = $('#pay-cvv', el);
    var ccNum = $('#cc-num', el);
    var ccExp = $('#cc-exp', el);

    function fmtCard(v) {
      return String(v).replace(/\D/g, '').slice(0, 16).replace(/(\d{4})(?=\d)/g, '$1 ');
    }
    num.addEventListener('input', function () {
      num.value = fmtCard(num.value);
      if (ccNum) ccNum.textContent = num.value || '•••• •••• •••• ••••';
    });
    exp.addEventListener('input', function () {
      var d = String(exp.value).replace(/\D/g, '').slice(0, 4);
      exp.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d;
      if (ccExp) ccExp.textContent = exp.value || 'MM/YY';
    });
    cvv.addEventListener('input', function () { cvv.value = String(cvv.value).replace(/\D/g, '').slice(0, 4); });

    $('#pay-back', el).addEventListener('click', function () { go('settings'); });

    $('#pay-now', el).addEventListener('click', function () {
      var digits = fmtCard(num.value).replace(/\s/g, '');
      var ok = digits.length === 16 && exp.value.replace(/\D/g, '').length === 4 && cvv.value.length >= 3;
      var host = $('#pay-result', el);
      if (!ok) { host.innerHTML = note('Enter a card number, expiry and CVV to continue.', 'bad'); return; }
      host.innerHTML = '';
      var button = $('#pay-now', el);
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span><span class="lbl">Taking payment…</span>';
      settle(el);
    });
  }

  /*
   * The checkout is settled on the server, per document: the server recomputes
   * the price from the owner's rates and the real page count and records the
   * payment, which is what lets the job print. This screen only decides *that*
   * the person agreed to pay, never how much.
   */
  function settle(el) {
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
        host.innerHTML = note(esc(failed[0]), 'bad');
        var button = $('#pay-now', el);
        button.disabled = false;
        button.innerHTML = icon('card') + '<span class="lbl">Try payment again</span>';
        return;
      }
      var total = paid.reduce(function (sum, p) { return sum + Number(p.amount || 0); }, 0);
      var pages = paid.reduce(function (sum, p) { return sum + Number(p.pages || 0); }, 0);
      state.payment = {
        currency: (state.printer.pricing || {}).currency,
        perPage: perPageRate(),
        pages: pages,
        total: Math.round(total * 100) / 100,
      };
      state.paid = true;
      persist();
      host.innerHTML = note('Payment received — sending to the printer.', 'ok');
      setTimeout(function () { submitPrint(el, $('#pay-now', el)); }, 420);
    });
  }

  /* ======================================================== send to print */

  function tokenFrom(res) {
    if (res && res.ticket && res.ticket.token) return res.ticket.token;
    if (res && res.token) return res.token;
    if (res && Array.isArray(res.tickets) && res.tickets.length) {
      var last = res.tickets[res.tickets.length - 1];
      if (last && last.token) return last.token;
    }
    return null;
  }

  function submitPrint(el, button) {
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
    if (button) {
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span><span class="lbl">Sending to the printer…</span>';
    }

    var tokens = [];
    var failed = [];

    function next(i) {
      if (i >= state.jobs.length) {
        if (tokens.length) {
          state.tokens = tokens;
          persist();
          go('token');
          return;
        }
        var msg = failed[0] || 'The job could not be sent to the printer.';
        if (host) host.innerHTML = note(esc(msg) + ' Nothing was charged — you can try again.', 'bad');
        if (button) {
          button.disabled = false;
          button.innerHTML = icon('printer') + '<span class="lbl">Try again</span>';
        }
        return;
      }
      var job = state.jobs[i];
      api('/jobs/' + encodeURIComponent(job.id) + '/print', { method: 'POST', body: body })
        .then(function (res) {
          var token = tokenFrom(res);
          if (token) tokens.push(token);
          else failed.push('No print token came back.');
          next(i + 1);
        })
        .catch(function (err) {
          failed.push(err && err.message ? err.message : 'Print request failed.');
          next(i + 1);
        });
    }

    next(0);
  }

  /* ========================================================== step: ticket */

  var ticketPoll = null;

  /* The three things that can happen to a print command, as a timeline: queued,
   * printing, printed — with the state the server last reported lit up. */
  function trackerMarkup(name) {
    var order = ['queued', 'printing', 'printed'];
    var labels = ['Queued', 'Printing', 'Printed'];
    var idx = order.indexOf(name);
    var hold = name === 'waiting';
    var bad = name === 'failed' || name === 'canceled';
    var finished = name === 'printed';

    var out = '<div class="tracker">';
    order.forEach(function (stepName, i) {
      var cls = '';
      if (bad) cls = i === 0 ? 'done' : i === 1 ? 'bad' : '';
      else if (hold) cls = i === 0 ? 'hold' : '';
      else if (finished || idx > i) cls = 'done';
      else if (idx === i) cls = 'active';

      var glyph = cls === 'done' ? icon('check')
        : cls === 'hold' ? icon('clock')
          : cls === 'bad' ? icon('warn')
            : String(i + 1);

      out += '<span class="track-node ' + cls + '">' +
        '<span class="track-dot">' + glyph + '</span>' +
        '<span class="track-name">' + labels[i] + '</span>' +
        '</span>';

      if (i < 2) {
        var lit = bad ? i === 0 : hold ? false : (finished ? true : idx > i);
        out += '<span class="track-link' + (lit ? ' lit' : '') + '"><i></i></span>';
      }
    });
    return out + '</div>';
  }

  function stateChip(ticket) {
    var name = ticket && ticket.state;
    var meta = TICKET_LABELS[name] || { text: 'Checking…', cls: 'grey' };
    var live = name === 'queued' || name === 'printing' || name === 'waiting';
    return '<span class="chip ' + meta.cls + '">' + (live ? '<span class="live-dot"></span>' : '') + esc(meta.text) + '</span>';
  }

  function renderToken() {
    var el = $('#step-token');
    var shop = isShop();
    var primary = state.tokens[0] || '';
    var printerName = (state.printer && state.printer.name) || 'the printer';
    var pages = estimatePages();

    el.innerHTML =
      '<div class="ticket-wrap">' +
      '<span class="seal">' + icon('checkCircle') + '</span>' +
      '<div class="eyebrow" style="justify-content:center">Your print token</div>' +
      '<h1 class="display">Show this at the <span class="grad">printer</span></h1>' +

      '<div class="ticket">' +
      '<span class="ticket-sheen" aria-hidden="true"></span>' +
      '<span class="ticket-perf" aria-hidden="true"></span>' +
      '<span class="ticket-label">Token number</span>' +
      '<span class="ticket-code" id="token-code">' + esc(primary) + '</span>' +
      '<p class="ticket-note">It is printed as the <b>first page</b> of your document, so nobody can pick up the wrong pages.</p>' +
      '<div class="rows">' +
      '<div class="line"><span>Printer</span><b>' + esc(printerName) + '</b></div>' +
      '<div class="line"><span>Token</span><b class="mono">' + esc(primary) + '</b></div>' +
      '<div class="line"><span>' + plural(state.jobs.length, 'document') + ' · ' + plural(pages, 'page') + '</span>' +
      '<b>' + (shop && state.mode ? (state.mode === 'color' ? 'Colour' : 'Black &amp; white') : 'Standard') +
      (state.settings.duplex ? ' · two sides' : '') + '</b></div>' +
      (state.payment && shop
        ? '<div class="line total"><span>Paid</span><span class="amt">' + esc(money(state.payment.total, state.payment.currency)) + '</span></div>'
        : '') +
      '</div>' +
      '<div id="tracker-host">' + trackerMarkup('queued') + '</div>' +
      '<div class="ticket-state"><span id="token-state">' + stateChip({ state: 'queued' }) + '</span></div>' +
      '<p class="ticket-why" id="token-why"></p>' +
      '</div>' +

      '<div class="ticket-actions">' +
      '<button class="btn" type="button" id="token-copy">' + icon('copy') + '<span class="lbl">Copy token</span></button>' +
      '<button class="btn ghost" type="button" id="token-another">Print another</button>' +
      '<button class="btn go" type="button" id="token-done">' + icon('check') + '<span class="lbl">Done</span></button>' +
      '</div>' +

      (state.tokens.length > 1
        ? '<p class="token-extra">' + plural(state.tokens.length, 'token') + ' issued — one per document: ' +
          state.tokens.map(function (t) { return '<span class="mono">' + esc(t) + '</span>'; }).join(', ') + '</p>'
        : '') +
      '</div>';

    $('#token-copy', el).addEventListener('click', function () { copyText(primary); });
    $('#token-another', el).addEventListener('click', function () {
      state.tokens = [];
      state.files = [];
      state.jobs = [];
      state.payment = null;
      state.paid = false;
      persist();
      go('upload');
    });
    $('#token-done', el).addEventListener('click', function () {
      reset();
      go('code');
    });

    watchTicket(primary);
  }

  /* Watch the token's state for a minute: the person is standing right there,
   * and "printed" is the answer they are waiting for. */
  function watchTicket(token) {
    clearInterval(ticketPoll);
    if (!token) return;
    var el = $('#step-token');
    var host = $('#token-state', el);
    var tracker = $('#tracker-host', el);
    var why = $('#token-why', el);
    var tries = 0;

    function paint(ticket) {
      var name = ticket && ticket.state;
      if (host) host.innerHTML = stateChip(ticket);
      if (tracker && name) tracker.innerHTML = trackerMarkup(name);
      var meta = TICKET_LABELS[name];
      if (why) why.textContent = meta ? meta.why : '';
    }

    function check() {
      tries++;
      api('/tickets/' + encodeURIComponent(token))
        .then(function (res) {
          var ticket = res && res.ticket;
          paint(ticket);
          if (ticket && ['printed', 'failed', 'canceled'].indexOf(ticket.state) !== -1) clearInterval(ticketPoll);
        })
        .catch(function () { /* keep the last known state */ });
      if (tries > 20) clearInterval(ticketPoll);
    }

    check();
    ticketPoll = setInterval(check, 3000);
  }

  function copyText(text) {
    var done = function () { toast('Token ' + text + ' copied', 'ok'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () { toast(text); });
        return;
      }
    } catch (e) { /* fall through */ }
    toast(text);
  }

  /* ================================================================ router */

  var renderers = {
    code: renderCode,
    mode: renderMode,
    details: renderDetails,
    upload: renderUpload,
    settings: renderSettings,
    payment: renderPayment,
    token: renderToken,
  };

  function boot() {
    restore();
    paintTheme();
    watchScroll();

    // A sticker's QR opens /print/?code=PP-XXXX-XXXX, so the code somebody just
    // scanned is already filled in for them.
    var scanned = codesFromUrl();
    var sameFlow = Boolean(scanned && state.printer && state.printer.code === scanned);
    if (scanned && !sameFlow) {
      reset();
      go('code');
      setCodeCells(scanned);
      submitCode(scanned);
      return;
    }

    // Reopening the tab right after printing should show the token again; a
    // fresh visit starts at the code, because that is what the person came for.
    if (state.tokens.length && state.step === 'token') return go('token');
    if (state.step && state.step !== 'code' && state.printer) {
      var steps = FLOWS[flowOf()];
      var resume = steps.indexOf(state.step) !== -1 ? state.step : (isShop() ? 'mode' : 'details');
      if (resume === 'upload' && !state.jobs.length) resume = isShop() ? 'mode' : 'details';
      if (resume === 'settings' && !state.jobs.length) resume = 'upload';
      if (resume === 'payment' && !state.jobs.length) resume = 'upload';
      go(resume);
      return;
    }

    reset();
    go('code');
  }

  function setCodeCells(code) {
    var inputs = $$('.code-cell');
    var body = codeBody(code);
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].value = body[i] || '';
      inputs[i].classList.toggle('filled', Boolean(body[i]));
    }
    var button = $('#code-go');
    if (button) button.classList.toggle('ready', body.length === CODE_LEN);
  }

  /* ------------------------------------------------------- theme + scroll */

  function paintTheme() {
    var current = document.documentElement.getAttribute('data-theme') === 'day' ? 'day' : 'dusk';
    var glyph = $('#theme-glyph');
    if (glyph) glyph.innerHTML = current === 'day' ? icon('moon') : icon('sun');
    var button = $('#theme-toggle');
    if (button) button.setAttribute('aria-label', current === 'day' ? 'Use the dark theme' : 'Use the light theme');
  }

  /* The browser chrome colour. Two media-scoped metas handle the "no choice
   * made" case; the moment somebody chooses, they collapse into one. (Not
   * `paintChrome` — that already paints the printer chip and the ribbon.) */
  function paintBrowserChrome(color) {
    var metas = $$('meta[name="theme-color"]');
    if (!metas.length) return;
    metas[0].setAttribute('content', color);
    metas[0].removeAttribute('media');
    for (var i = metas.length - 1; i >= 1; i--) {
      if (metas[i].parentNode) metas[i].parentNode.removeChild(metas[i]);
    }
  }

  function watchScroll() {
    var onScroll = function () {
      document.body.classList.toggle('scrolled', window.scrollY > 6);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  $('#theme-toggle').addEventListener('click', function () {
    var toDay = document.documentElement.getAttribute('data-theme') !== 'day';
    document.documentElement.setAttribute('data-theme', toDay ? 'day' : 'dusk');
    try { localStorage.setItem(THEME_KEY, toDay ? 'light' : 'dark'); } catch (e) { /* private mode */ }
    paintTheme();
    paintBrowserChrome(toDay ? '#f4f6fb' : '#0a0d16');
  });

  /* The printer chip is the way back to the machine you are printing to. */
  var chip = $('#printer-chip');
  if (chip) {
    chip.addEventListener('click', function () {
      if (!state.printer) return go('code');
      go(isShop() ? 'mode' : 'details');
    });
  }

  if (document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
