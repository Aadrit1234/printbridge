/* REST client for the admin API (/api/admin).
 *
 * Every call carries the session cookie. A 401 means the session expired or was
 * revoked, so the app drops straight back to the sign-in screen. */

/* Where the backend lives. Empty when the admin console is served by the
 * backend itself (same origin, cookies stay Strict same-site); a static
 * deployment points this at the backend's public URL in config.js, and the
 * backend must list that origin in ALLOWED_ORIGINS. */
const CFG = window.PRINTBRIDGE_CONFIG || {};
const ORIGIN = String(CFG.apiBase || '').replace(/\/+$/, '');
const BASE = `${ORIGIN}/api/admin`;
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

async function request(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
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
    res = await fetch(BASE + path, options);
  } catch {
    throw new ApiError('Cannot reach the print server — is it still running?', 0, null);
  }

  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json().catch(() => null) : null;

  if (res.status === 401) {
    const error = new ApiError((payload && payload.error) || 'Sign-in required', 401, payload);
    if (path !== '/login') onUnauthorized(error);
    throw error;
  }
  if (!res.ok) {
    throw new ApiError((payload && payload.error) || `Request failed (${res.status})`, res.status, payload);
  }
  return raw ? res : payload;
}

export const api = {
  /* ---------------- access ---------------- */
  session: () => request('/session'),
  login: (pin) => request('/login', { method: 'POST', body: { pin } }),
  logout: () => request('/logout', { method: 'POST', body: {} }),
  changePin: (currentPin, nextPin) => request('/pin', { method: 'POST', body: { currentPin, nextPin } }),
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

  /** Admin upload (used by nothing by default, but the route exists). */
  upload(files, { options = {}, onProgress = () => {}, batchId } = {}) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      for (const file of files) form.append('files', file, file.name || 'upload');
      if (batchId) form.append('batchId', batchId);
      if (options.copies) form.append('copies', String(options.copies));
      if (options.paper) form.append('paper', options.paper);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/jobs`);
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
