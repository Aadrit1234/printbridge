/* Generates the app icons (PWA + favicon) from an inline SVG.
 *
 * The mark is the Lucide "printer" icon (https://lucide.dev/icons/printer,
 * ISC License) — the same icon set the whole app uses, so the installed app
 * and the in-app iconography are one system. No emoji, no icon font, no CDN.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const outDir = path.join(__dirname, '..', 'public', 'assets');
fs.mkdirSync(outDir, { recursive: true });

/** Lucide "printer" geometry, in its native 24×24 coordinate space. */
const LUCIDE_PRINTER = `
  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
  <path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/>
  <rect x="6" y="14" width="12" height="8" rx="1"/>`;

function svg(size, { maskable = false } = {}) {
  const pad = maskable ? size * 0.18 : size * 0.1;
  const inner = size - pad * 2;
  const rx = maskable ? 0 : size * 0.24;
  // Glyph box inside the tile: tighter for maskable icons so nothing is
  // clipped when an OS masks it into a circle or squircle.
  const glyph = inner * (maskable ? 0.44 : 0.54);
  const scale = glyph / 24;
  const offset = pad + (inner - glyph) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#2dd4bf"/>
        <stop offset="0.55" stop-color="#22d3ee"/>
        <stop offset="1" stop-color="#818cf8"/>
      </linearGradient>
    </defs>
    <rect width="${size}" height="${size}" rx="${rx}" fill="#070b10"/>
    <rect x="${pad}" y="${pad}" width="${inner}" height="${inner}" rx="${maskable ? size * 0.22 : size * 0.24}" fill="url(#g)"/>
    <g transform="translate(${offset} ${offset}) scale(${scale})"
       fill="none" stroke="#05131a" stroke-width="1.9"
       stroke-linecap="round" stroke-linejoin="round">${LUCIDE_PRINTER}
    </g>
  </svg>`;
}

async function write(name, size, opts) {
  const buf = await sharp(Buffer.from(svg(size, opts))).png().toBuffer();
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(`[icons] ${name} (${size}px, ${(buf.length / 1024).toFixed(1)} KB)`);
}

(async () => {
  await write('icon-192.png', 192);
  await write('icon-512.png', 512);
  await write('icon-maskable-512.png', 512, { maskable: true });
})().catch((e) => {
  console.error('[icons] failed:', e.message);
  process.exit(1);
});
