/* REST client for the guest API (/api/v1).
 *
 * This is the whole surface a phone that scanned the QR code can reach: upload,
 * preview, print, and its own jobs. Printer setup, defaults, storage and other
 * people's jobs live in the admin app (/admin) and are not reachable from here.
 */

import { deviceId, DEVICE_HEADER } from './device.js';

/* Where the backend lives. Empty on a self-hosted install (same origin); a
 * static deployment of this frontend points it at the backend's public URL in
 * config.js. Every URL below is built from these two, so nothing else has to
 * care where the app is served from. */
const CFG = window.PRINTBRIDGE_CONFIG || {};
export const API_ORIGIN = String(CFG.apiBase || '').replace(/\/+$/, '');
const BASE = `${API_ORIGIN}/api/v1`;

/* NOTE: the guest app deliberately knows nothing about the admin console —
 * there is no admin link, no admin URL and no admin API in this bundle. The
 * control room is reached by typing its address, which is what keeps this site
 * a clean, single-purpose thing for the person printing. */

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload || null;
  }
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const options = {
    method,
    headers: { [DEVICE_HEADER]: deviceId(), ...headers },
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
  if (!res.ok) {
    throw new ApiError((payload && payload.error) || `Request failed (${res.status})`, res.status, payload);
  }
  return payload;
}

export const api = {
  meta: () => request('/system/meta'),
  settings: () => request('/system/settings'),
  printerStatus: (fresh = false) => request(`/printer/status${fresh ? '?fresh=1' : ''}`),

  /** Printers this device may choose from, plus the house default. */
  printers: () => request('/printers'),

  /** Look up a print command by its code. */
  ticket: (token) => request(`/tickets/${encodeURIComponent(token)}`),

  jobs: (limit = 100) => request(`/jobs?limit=${limit}`),
  job: (id) => request(`/jobs/${encodeURIComponent(id)}`),
  jobMeta: (id) => request(`/files/${encodeURIComponent(id)}/meta`),
  print: (id, options) => request(`/jobs/${encodeURIComponent(id)}/print`, { method: 'POST', body: options || {} }),
  cancel: (id) => request(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
  retry: (id) => request(`/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: {} }),
  remove: (id) => request(`/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /* Image tags, downloads and new tabs cannot send the X-Device-Id header, so
   * the same identity travels as a query parameter on file URLs. */
  previewUrl: (id, page) => `${BASE}/files/${encodeURIComponent(id)}/preview/${page}.png?device=${encodeURIComponent(deviceId())}`,
  thumbUrl: (id) => `${BASE}/files/${encodeURIComponent(id)}/thumb.png?device=${encodeURIComponent(deviceId())}`,
  pdfUrl: (id) => `${BASE}/files/${encodeURIComponent(id)}/pdf?device=${encodeURIComponent(deviceId())}`,
  originalUrl: (id) => `${BASE}/files/${encodeURIComponent(id)}/original?device=${encodeURIComponent(deviceId())}`,

  /** Upload with real progress reporting (XHR, so we get upload events). */
  upload(files, { options = {}, onProgress = () => {}, batchId } = {}) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      for (const file of files) form.append('files', file, file.name || 'upload');
      if (batchId) form.append('batchId', batchId);
      if (options.copies) form.append('copies', String(options.copies));
      if (options.paper) form.append('paper', options.paper);
      if (options.scale) form.append('scale', options.scale);
      if (options.duplex !== undefined) form.append('duplex', String(Boolean(options.duplex)));

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/jobs`);
      xhr.setRequestHeader(DEVICE_HEADER, deviceId());
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
      xhr.addEventListener('abort', () => reject(new ApiError('Upload canceled', 0, null)));
      xhr.send(form);
    });
  },
};
