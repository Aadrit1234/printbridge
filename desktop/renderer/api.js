/* REST client for the two admin-facing APIs.
 *
 *   /api/admin  the machine, behind its own sign-in — jobs, printers, the print path
 *   /api/owner  the licence, behind an owner account — plans, account, printers
 *
 * Every call carries the session cookie. A 401 on the machine API means the
 * session expired or was revoked, so the app drops straight back to the sign-in
 * screen.
 *
 * Both are same-origin: the desktop app's own host (desktop/host.js) serves
 * this interface and proxies /api/* to the print service, so there is no origin
 * to configure and no CORS to satisfy. */
const ORIGIN = '';
const BASE = '/api/admin';
const OWNER_BASE = '/api/owner';
export const API_ORIGIN = ORIGIN;

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload || null;
  }
}

/** Called with the error whenever the server says "sign in again". */
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn || (() => {}); }

async function send(base, path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const options = {
    method,
    // "include" also sends the session cookie when the API is cross-origin.
    credentials: 'include',
    headers: { ...headers },
  };
  if (body !== undefined && !(body instanceof FormData)) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    options.body = body;
  }

  let res;
  try {
    res = await fetch(base + path, options);
  } catch {
    throw new ApiError('Cannot reach the print service — is it still running?', 0, null);
  }

  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json().catch(() => null) : null;

  if (res.status === 401) {
    const error = new ApiError((payload && payload.error) || 'Sign-in required', 401, payload);
    // Only the machine API re-arms the sign-in screen; losing a licence session
    // must not lock you out of the printer.
    if (base === BASE && path !== '/login') onUnauthorized(error);
    throw error;
  }
  if (!res.ok) {
    throw new ApiError((payload && payload.error) || `Request failed (${res.status})`, res.status, payload);
  }
  return raw ? res : payload;
}

const SHOP_BASE = '/api/shop';

function request(path, options) { return send(BASE, path, options); }
function ownerRequest(path, options) { return send(OWNER_BASE, path, options); }
function shopRequest(path, options) { return send(SHOP_BASE, path, options); }

/**
 * The business half — pricing's services, expenses, revenue.
 *
 * These need an owner account, not this machine's own sign-in: they are the licence
 * holder's books, and a machine keeps books for nobody. The renderer keeps a
 * local copy of the document and syncs it; the machine's copy is the meeting
 * point, not the master (see desktop/renderer/shop.js).
 */
export const shopApi = {
  document: () => shopRequest('/'),
  sync: (document) => shopRequest('/sync', { method: 'POST', body: { document } }),
  reports: ({ from = '', to = '' } = {}) => shopRequest(`/reports?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  csvUrl: ({ from = '', to = '' } = {}) => `${SHOP_BASE}/reports.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
};

export const api = {
  /* ---------------- access ---------------- */
  session: () => request('/session'),
  /** This machine's own sign-in, or an owner account's email and password. */
  login: (username, password) => request('/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/logout', { method: 'POST', body: {} }),
  setCredentials: ({ currentPassword, username, password }) => request('/credentials', { method: 'POST', body: { currentPassword, username, password } }),
  signOutOtherDevices: () => request('/sessions/revoke', { method: 'POST', body: {} }),
  closeAllSessions: () => request('/sessions/close-all', { method: 'POST', body: {} }),
  guestLink: () => request('/guest-link'),

  /* ---------------- system ---------------- */
  meta: () => request('/system/meta'),
  settings: () => request('/system/settings'),
  updateSettings: (patch) => request('/system/settings', { method: 'PATCH', body: patch }),
  logs: (limit = 200) => request(`/system/logs?limit=${limit}`),
  diagnostics: () => request('/system/diagnostics'),
  cleanupStorage: () => request('/system/storage/cleanup', { method: 'POST', body: {} }),

  /* ---------------- printer ---------------- */
  printerStatus: (fresh = false) => request(`/printer/status${fresh ? '?fresh=1' : ''}`),
  printerBackends: () => request('/printer/backends'),
  printerTools: () => request('/printer/tools'),
  printerLocate: (opts = {}) => request('/printer/locate', { method: 'POST', body: opts }),
  printerSelect: (patch) => request('/printer/select', { method: 'POST', body: patch }),
  printerRefresh: () => request('/printer/refresh', { method: 'POST', body: {} }),
  printerTest: () => request('/printer/test', { method: 'POST', body: {} }),
  printerInstallHelper: () => request('/printer/tools/sumatra', { method: 'POST', body: {} }),
  printerQueueDepth: () => request('/printer/queue-depth'),
  printerWake: () => request('/printer/wake', { method: 'POST', body: {} }),

  /* ---------------- walk-up printers ---------------- */
  printers: () => request('/printers'),
  printer: (id) => request(`/printers/${encodeURIComponent(id)}`),
  printerByCode: (value) => request(`/printers/lookup/${encodeURIComponent(value)}`),
  createPrinter: (body) => request('/printers', { method: 'POST', body }),
  updatePrinter: (id, patch) => request(`/printers/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  deletePrinter: (id) => request(`/printers/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /* ---------------- jobs ---------------- */
  jobs: (limit = 100) => request(`/jobs?limit=${limit}`),
  job: (id) => request(`/jobs/${encodeURIComponent(id)}`),
  jobMeta: (id) => request(`/files/${encodeURIComponent(id)}/meta`),
  print: (id, options) => request(`/jobs/${encodeURIComponent(id)}/print`, { method: 'POST', body: options || {} }),
  cancel: (id) => request(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
  retry: (id) => request(`/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: {} }),
  remove: (id) => request(`/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clearFinished: () => request('/jobs', { method: 'DELETE' }),
  outbox: () => request('/files/outbox.json'),

  /* ---------------- pairing ---------------- */
  printQrCard: (url = '') => request(`/system/pairing/card/print${url ? `?url=${encodeURIComponent(url)}` : ''}`, { method: 'POST', body: {} }),
  qrUrl: (data) => `${BASE}/system/pairing/qr.png?data=${encodeURIComponent(data)}`,
  /** The printable QR poster for the address people print from. */
  cardUrl: (url = '') => `${BASE}/system/pairing/card.pdf${url ? `?url=${encodeURIComponent(url)}` : ''}`,

  /* ---------------- files ---------------- */
  previewUrl: (id, page) => `${BASE}/files/${encodeURIComponent(id)}/preview/${page}.png`,
  thumbUrl: (id) => `${BASE}/files/${encodeURIComponent(id)}/thumb.png`,
  pdfUrl: (id) => `${BASE}/files/${encodeURIComponent(id)}/pdf`,
  originalUrl: (id) => `${BASE}/files/${encodeURIComponent(id)}/original`,
  outboxUrl: (name) => `${BASE}/files/outbox/${encodeURIComponent(name)}`,

  /** Upload through the admin API (the route exists; the guest page is the usual path). */
  upload(files, { options = {}, onProgress = () => {}, batchId } = {}) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      for (const file of files) form.append('files', file, file.name || 'upload');
      if (batchId) form.append('batchId', batchId);
      if (options.copies) form.append('copies', String(options.copies));
      if (options.paper) form.append('paper', options.paper);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/jobs`);
      // Same origin as this page: the host proxies it to the print service.
      xhr.withCredentials = true;
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      });
      xhr.addEventListener('load', () => {
        let payload = null;
        try { payload = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300 && payload) resolve(payload);
        else reject(new ApiError((payload && payload.error) || `Upload failed (${xhr.status})`, xhr.status, payload));
      });
      xhr.addEventListener('error', () => reject(new ApiError('Upload failed — check the connection', 0, null)));
      xhr.send(form);
    });
  },
};

/* ---------------------------------------------------------------- owner API */

/* The licence: a second identity on the same machine, and deliberately not the
 * same session as the machine. An owner account sees only its own printers. */

export const ownerApi = {
  plans: () => ownerRequest('/plans'),
  session: () => ownerRequest('/session'),
  signup: (body) => ownerRequest('/signup', { method: 'POST', body }),
  login: (body) => ownerRequest('/login', { method: 'POST', body }),
  logout: () => ownerRequest('/logout', { method: 'POST', body: {} }),
  account: () => ownerRequest('/account'),
  updateAccount: (patch) => ownerRequest('/account', { method: 'PATCH', body: patch }),
  printers: () => ownerRequest('/printers'),
};

/* ---------------------------------------------------------------- the app */

/* The Electron bridge. Present only inside the desktop app: the service
 * lifetime, the folders, the login item, the power blocker, the process log,
 * the real suites and updates are things a web page must not be able to do.
 * Every one of them degrades to a rejected promise rather than a silent no-op,
 * so a view can hide what it cannot offer. */

const bridge = typeof window === 'undefined' ? null : (window.printbridgeDesktop || null);

function desktopOnly(what) {
  return Promise.reject(new Error(`${what} is only available in the desktop app`));
}

export const desktop = {
  available: () => Boolean(bridge),

  getInfo: () => (bridge ? bridge.getInfo() : desktopOnly('This')),
  restartServer: () => (bridge ? bridge.restartServer() : desktopOnly('Restarting the service')),
  openDataFolder: () => (bridge ? bridge.openDataFolder() : desktopOnly('Opening the data folder')),
  openExternal: (url) => (bridge ? bridge.openExternal(url) : desktopOnly('Opening a browser')),
  rememberPassword: (password) => (bridge ? bridge.rememberPassword(password) : Promise.resolve(false)),
  runSelfTest: () => (bridge ? bridge.runSelfTest() : desktopOnly('The end-to-end suites')),

  autostart: {
    get: () => (bridge ? bridge.autostart.get() : Promise.resolve({ supported: false, enabled: false })),
    set: (enabled) => (bridge ? bridge.autostart.set(enabled) : desktopOnly('Autostart')),
  },

  keepAwake: {
    get: () => (bridge ? bridge.keepAwake.get() : Promise.resolve({ enabled: false })),
    set: (enabled) => (bridge ? bridge.keepAwake.set(enabled) : desktopOnly('Staying awake')),
  },

  /* The machine this console is pointed at. Meaningful in the shop's app, where
   * the machine is somewhere else on the network; the machine's own app never
   * asks — it is the machine. */
  machines: {
    list: () => (bridge && bridge.machines ? bridge.machines.list() : Promise.resolve({ current: null, known: [] })),
    discover: () => (bridge && bridge.machines ? bridge.machines.discover() : Promise.resolve({ current: null, found: [], known: [] })),
    check: (address) => (bridge && bridge.machines ? bridge.machines.check(address) : desktopOnly('Checking a machine')),
    use: (machine) => (bridge && bridge.machines ? bridge.machines.use(machine) : desktopOnly('Choosing a machine')),
    forget: (id) => (bridge && bridge.machines ? bridge.machines.forget(id) : desktopOnly('Forgetting a machine')),
  },

  /* The shop's own document, kept on this computer (see renderer/shop.js). */
  shop: {
    load: (accountId) => (bridge && bridge.shop ? bridge.shop.load(accountId) : Promise.resolve({ document: null })),
    save: (accountId, state) => (bridge && bridge.shop ? bridge.shop.save(accountId, state) : Promise.resolve({ ok: false, error: 'not in the desktop app' })),
  },

  notifications: {
    get: () => (bridge && bridge.notifications ? bridge.notifications.get() : Promise.resolve({ supported: false, enabled: false })),
    set: (enabled) => (bridge && bridge.notifications ? bridge.notifications.set(enabled) : desktopOnly('Notifications')),
  },

  logs: {
    get: () => (bridge ? bridge.logs.get() : Promise.resolve({ lines: [] })),
    clear: () => (bridge ? bridge.logs.clear() : Promise.resolve(false)),
    subscribe: (fn) => (bridge ? bridge.logs.subscribe(fn) : () => {}),
  },

  /** The menu bar and tray switch panels through this. */
  onNavigate: (fn) => (bridge && bridge.onNavigate ? bridge.onNavigate(fn) : () => {}),

  /* null in a browser, so a view can test for it before offering updates. */
  updates: bridge && bridge.updates ? {
    status: () => bridge.updates.status(),
    check: () => bridge.updates.check(),
    install: () => bridge.updates.install(),
    subscribe: (fn) => bridge.updates.subscribe(fn),
  } : null,
};
