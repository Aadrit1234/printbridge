/* Device identity.
 *
 * A guest only ever sees the jobs *this browser* created, so every guest
 * request carries a device id. It is random, local, and meaningless to anyone
 * else — it is not an account, and clearing site data simply starts a fresh
 * one (older jobs then belong to nobody and only the admin can see them).
 */

const KEY = 'printbridge.device';

function makeId() {
  const bytes = new Uint8Array(9);
  (globalThis.crypto || {}).getRandomValues
    ? crypto.getRandomValues(bytes)
    : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `dev_${hex}`;
}

let cached = null;

export function deviceId() {
  if (cached) return cached;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && /^[0-9a-zA-Z_-]{4,64}$/.test(saved)) {
      cached = saved;
      return cached;
    }
  } catch { /* private mode */ }
  cached = makeId();
  try { localStorage.setItem(KEY, cached); } catch { /* private mode */ }
  return cached;
}

export const DEVICE_HEADER = 'x-device-id';
