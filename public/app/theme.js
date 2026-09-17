/* Theme handling shared by the shell and the settings view. */

const KEY = 'pb.theme';

export function systemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function currentTheme() {
  return localStorage.getItem(KEY) || 'system';
}

export function applyTheme(theme) {
  const resolved = theme === 'system' ? systemTheme() : theme;
  document.documentElement.setAttribute('data-theme', resolved);
  localStorage.setItem(KEY, theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#eef2f5' : '#070b10');
  return resolved;
}

export function resolvedTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

export function toggleTheme() {
  const next = resolvedTheme() === 'light' ? 'dark' : 'light';
  applyTheme(next);
  return next;
}
