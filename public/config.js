/* Runtime configuration — the one file a static deployment rewrites.
 *
 * Self-hosted (npm start), the frontend and the API share an origin, so both
 * values are empty and everything is relative. That is the normal case and the
 * safest one: no CORS, and the admin session cookie stays `SameSite=Strict`.
 *
 * When the frontend is hosted elsewhere (Vercel, Netlify, GitHub Pages), a
 * build points these at the backend instead:
 *
 *   apiBase   full origin of the backend, e.g. https://printbridge.tailnet-1234.ts.net
 *             (empty = this origin)
 *   adminUrl  where the admin console lives, e.g. https://printbridge.vercel.app/admin
 *             (empty = /admin on this origin)
 *
 * The backend must list that frontend origin in ALLOWED_ORIGINS or the browser
 * will refuse every request — see docs/deploy.md.
 */
window.PRINTBRIDGE_CONFIG = Object.assign(
  { apiBase: '', adminUrl: '' },
  window.PRINTBRIDGE_CONFIG || {}
);
