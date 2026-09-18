'use strict';
/* Everything that is uploaded becomes a print-ready PDF.
 *
 * The PDF is exactly what gets submitted to the printer, so the preview we
 * rasterize from it is a faithful "what you see is what prints" view. */

const path = require('path');
const sharp = require('sharp');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const log = require('../logger').make('converter');
const render = require('./render');
const { winAnsiSafe } = require('./pdf-text');

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const IMAGE_TARGET = { width: 1240, height: 1754 }; // ≈150 DPI on A4

function classify(originalName, mime) {
  const ext = (path.extname(originalName || '') || '').toLowerCase();
  const m = String(mime || '');
  if (ext === '.pdf' || m === 'application/pdf') return { kind: 'pdf', ext };
  if (
    m.startsWith('image/') ||
    ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.bmp', '.tif', '.tiff'].includes(ext)
  ) return { kind: 'image', ext };
  if (m === 'text/plain' || ['.txt', '.csv', '.log', '.md', '.text'].includes(ext)) return { kind: 'text', ext };
  if (/\.(docx?|odt|rtf|pptx?|odp|xlsx?|ods)$/.test(ext) ||
      /wordprocessingml|spreadsheetml|presentationml|opendocument/.test(m)) return { kind: 'office', ext };
  return { kind: 'unknown', ext };
}

const SUPPORTED = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.bmp', '.tif', '.tiff',
  '.txt', '.csv', '.log', '.md', '.doc', '.docx', '.odt', '.rtf', '.ppt', '.pptx', '.xls', '.xlsx', '.ods'];

/* ---------------- images ---------------- */

async function imageToPdf(buffer) {
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  const frames = Math.max(1, Math.min(meta.pages || 1, 50));
  const pdf = await PDFDocument.create();

  for (let frame = 0; frame < frames; frame++) {
    const { data, info } = await sharp(buffer, { failOn: 'none', page: frame })
      .rotate() // apply EXIF orientation
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
      .resize({ ...IMAGE_TARGET, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const embedded = await pdf.embedPng(png);
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    const scale = Math.min((PAGE_W - 28) / embedded.width, (PAGE_H - 28) / embedded.height, 1);
    const w = embedded.width * scale;
    const h = embedded.height * scale;
    page.drawImage(embedded, { x: (PAGE_W - w) / 2, y: (PAGE_H - h) / 2, width: w, height: h });
  }
  return { pdfBytes: await pdf.save(), pageCount: frames };
}

/* ---------------- plain text ---------------- */

async function textToPdf(buffer, name) {
  const text = winAnsiSafe(buffer.toString('utf8').replace(/\r\n?/g, '\n'));
  if (text.includes('\u0000')) throw new Error('This looks like a binary file, not text');

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Courier);
  const SIZE = 10.5, LINE = 14, MARGIN = 40;
  const maxCols = Math.floor((PAGE_W - MARGIN * 2) / font.widthOfTextAtSize('M', SIZE));

  const addPage = () => pdf.addPage([PAGE_W, PAGE_H]);
  let page = addPage();
  let y = PAGE_H - MARGIN;

  const drawLine = (line) => {
    if (y < MARGIN) { page = addPage(); y = PAGE_H - MARGIN; }
    page.drawText(line, { x: MARGIN, y, size: SIZE, font, color: rgb(0.06, 0.08, 0.08) });
    y -= LINE;
  };

  const segments = text.replace(/\t/g, '    ').split('\f');
  for (let s = 0; s < segments.length; s++) {
    if (s > 0) { page = addPage(); y = PAGE_H - MARGIN; }
    for (const rawLine of segments[s].split('\n')) {
      if (pdf.getPageCount() > 400) throw new Error('Text file is too long (400+ pages)');
      let line = rawLine;
      while (line.length > maxCols) {
        let cut = line.lastIndexOf(' ', maxCols);
        if (cut < maxCols * 0.5) cut = maxCols;
        drawLine(line.slice(0, cut));
        line = line.slice(cut).trimStart();
      }
      drawLine(line);
    }
  }
  void name;
  return { pdfBytes: await pdf.save(), pageCount: pdf.getPageCount() };
}

/* ---------------- dispatcher ---------------- */

async function toPdf(buffer, originalName, mime) {
  const { kind } = classify(originalName, mime);
  switch (kind) {
    case 'pdf': {
      // A .pdf extension is a claim, not proof. A renamed or truncated file
      // used to be accepted here and sent to the printer as raw garbage, so
      // check the header (the spec allows it anywhere in the first 1 KB).
      if (!buffer.subarray(0, 1024).toString('latin1').includes('%PDF-')) {
        throw new Error('This file is not a valid PDF — it may have been renamed or damaged in transfer');
      }
      let pageCount = null;
      try { pageCount = (await PDFDocument.load(buffer, { ignoreEncryption: true })).getPageCount(); } catch { /* printer may still cope */ }
      return { pdfBytes: buffer, pageCount, kind };
    }
    case 'image':
      return { ...(await imageToPdf(buffer)), kind };
    case 'text':
      return { ...(await textToPdf(buffer, originalName)), kind };
    case 'office': {
      const pdfBytes = await render.officeToPdf(buffer, originalName);
      let pageCount = null;
      try { pageCount = (await PDFDocument.load(pdfBytes, { ignoreEncryption: true })).getPageCount(); } catch { /* ignore */ }
      log.info(`converted Office document "${originalName}" via LibreOffice`);
      return { pdfBytes, pageCount, kind };
    }
    default:
      throw new Error(`Unsupported file type "${path.extname(originalName) || mime}" — supported: PDF, images, text, Office documents`);
  }
}

module.exports = { toPdf, classify, SUPPORTED, winAnsiSafe };
