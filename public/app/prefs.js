/* Small, local preferences for the guest site.
 *
 * Nothing here is secret or server-side: which printer this browser last chose,
 * and the print codes it has seen (so a code can be checked again after a
 * reload). Clearing site data simply forgets them.
 */

const PRINTER_KEY = 'printbridge.printer';
const CODES_KEY = 'printbridge.codes';
const MAX_CODES = 40;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

/* ---------------- printer ---------------- */

export function chosenPrinter() {
  const value = read(PRINTER_KEY, null);
  return typeof value === 'string' && value ? value : null;
}

export function setChosenPrinter(id) {
  write(PRINTER_KEY, id || null);
}

/* ---------------- print codes ---------------- */

export function savedCodes() {
  const list = read(CODES_KEY, []);
  return Array.isArray(list) ? list.filter(c => typeof c === 'string') : [];
}

/** Remember a code, newest first, without duplicates. */
export function rememberCode(token) {
  if (!token) return;
  const list = [token, ...savedCodes().filter(c => c !== token)].slice(0, MAX_CODES);
  write(CODES_KEY, list);
}
