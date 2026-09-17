'use strict';
/* PDF → PNG page images, used for the true print preview and queue thumbnails.
 *
 * Two Node-specific gotchas are handled deliberately here (both were verified
 * empirically):
 *   1. pdf.js needs browser canvas globals (Path2D, ImageData, DOMMatrix,
 *      createCanvas…) — @napi-rs/canvas supplies them.
 *   2. standardFontDataUrl must be a PLAIN FILESYSTEM PATH (not file://);
 *      pdf.js's Node loader uses fs.readFile. And do NOT enable
 *      useSystemFonts:true — Node has no system fonts and glyphs render blank. */

const path = require('path');
const napiCanvas = require('@napi-rs/canvas');
const sharp = require('sharp');
const log = require('../logger').make('rasterizer');

for (const name of ['Path2D', 'ImageData', 'Image', 'DOMMatrix', 'DOMPoint', 'createCanvas', 'createImageData']) {
  if (typeof globalThis[name] === 'undefined' && napiCanvas[name]) globalThis[name] = napiCanvas[name];
}

const STANDARD_FONTS = path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep;
const DPI = 150;
const MAX_WIDTH = 1240; // ≈150 DPI on A4, keeps preview sharp but light

let pdfjsPromise = null;
async function pdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function openDocument(pdfBytes) {
  const lib = await pdfjs();
  return lib.getDocument({
    data: new Uint8Array(pdfBytes),
    isEvalSupported: false,
    standardFontDataUrl: STANDARD_FONTS,
  }).promise;
}

/** Page geometry in points (post-rotation), useful for previews and diagnostics. */
async function pageSizes(pdfBytes) {
  const doc = await openDocument(pdfBytes);
  try {
    const sizes = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const view = page.getViewport({ scale: 1 });
      sizes.push({ page: i, width: Math.round(view.width), height: Math.round(view.height), rotate: page.rotate || 0 });
      page.cleanup();
    }
    return { pageCount: doc.numPages, sizes };
  } finally {
    try { await doc.destroy(); } catch { /* cosmetic in fake-worker mode */ }
  }
}

/** Render selected pages (1-based) to PNG buffers. */
async function renderPages(pdfBytes, pages) {
  const doc = await openDocument(pdfBytes);
  const out = new Map();
  try {
    for (const pageNumber of pages) {
      if (pageNumber < 1 || pageNumber > doc.numPages) continue;
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(DPI / 72, MAX_WIDTH / base.width);
      const viewport = page.getViewport({ scale });

      const canvas = napiCanvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: context, viewport }).promise;
      out.set(pageNumber, await sharp(canvas.toBuffer('image/png')).png({ compressionLevel: 9 }).toBuffer());
      page.cleanup();
    }
    return { pages: out, pageCount: doc.numPages };
  } finally {
    try { await doc.destroy(); } catch { /* cosmetic */ }
  }
}

async function renderPage(pdfBytes, pageNumber) {
  const { pages } = await renderPages(pdfBytes, [pageNumber]);
  const buf = pages.get(pageNumber);
  if (!buf) throw new Error(`Page ${pageNumber} is out of range`);
  return buf;
}

async function thumbnail(pngBuffer, width = 240) {
  return sharp(pngBuffer).resize({ width, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
}

module.exports = { renderPages, renderPage, pageSizes, thumbnail, DPI, MAX_WIDTH };
