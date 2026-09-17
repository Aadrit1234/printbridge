'use strict';
/* Document generators that are produced by the app itself:
 *   - Office → PDF (optional, needs LibreOffice)
 *   - the printer test page
 *   - the printable QR pairing card (printed through the normal job pipeline) */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const QRCode = require('qrcode');
const log = require('../logger').make('render');

const A4 = [595.28, 841.89];

/* ---------------- LibreOffice bridge (optional) ---------------- */

let sofficeCache;

async function findSoffice() {
  if (sofficeCache !== undefined) return sofficeCache;
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
      ]
    : ['/usr/bin/soffice', '/usr/local/bin/soffice', '/opt/homebrew/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'];

  for (const c of candidates) if (fs.existsSync(c)) { sofficeCache = c; return c; }

  sofficeCache = await new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    execFile(cmd, ['soffice'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      const hit = String(stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
      resolve(!err && hit ? hit : null);
    });
  });
  return sofficeCache;
}

async function hasOfficeSupport() { return Boolean(await findSoffice()); }

async function officeToPdf(buffer, originalName) {
  const soffice = await findSoffice();
  if (!soffice) {
    throw new Error('Office files need LibreOffice installed on the print server — or save the file as PDF first');
  }
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-office-'));
  const safeName = String(originalName).replace(/[^\w.\- ()\u00C0-\u024F]/g, '_');
  const inputPath = path.join(workDir, safeName);
  await fsp.writeFile(inputPath, buffer);
  try {
    await new Promise((resolve, reject) => {
      execFile(soffice, ['--headless', '--norestore', '--nolockcheck', '--convert-to', 'pdf', '--outdir', workDir, inputPath],
        { timeout: 120000, windowsHide: true }, (err) => (err ? reject(new Error('LibreOffice conversion failed: ' + err.message)) : resolve()));
    });
    const pdfPath = path.join(workDir, path.basename(inputPath).replace(/\.[^.]+$/, '.pdf'));
    return await fsp.readFile(pdfPath);
  } finally {
    fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---------------- test page ---------------- */

async function testPagePdf({ printerName, backendLabel, serverUrl }) {
  const pdf = await PDFDocument.create();
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const page = pdf.addPage(A4);
  const { width, height } = page.getSize();

  page.drawRectangle({ x: 0, y: height - 120, width, height: 120, color: rgb(0.04, 0.24, 0.23) });
  page.drawText('PrintBridge', { x: 44, y: height - 58, size: 30, font: bold, color: rgb(1, 1, 1) });
  page.drawText('Printer test page', { x: 44, y: height - 88, size: 12, font: regular, color: rgb(0.72, 0.95, 0.9) });

  const rows = [
    ['Printed at', new Date().toLocaleString()],
    ['Printer', printerName || 'not named'],
    ['Print path', backendLabel || 'unknown'],
    ['Server', serverUrl || 'localhost'],
  ];
  let y = height - 190;
  for (const [label, value] of rows) {
    page.drawText(label.toUpperCase(), { x: 44, y, size: 8.5, font: bold, color: rgb(0.42, 0.5, 0.49) });
    page.drawText(String(value), { x: 44, y: y - 16, size: 12, font: mono, color: rgb(0.1, 0.13, 0.13) });
    y -= 52;
  }

  page.drawText('If you can read this, documents uploaded in the web app will print correctly.', {
    x: 44, y: y - 6, size: 11, font: regular, color: rgb(0.2, 0.25, 0.25),
  });

  page.drawText('Grayscale ramp', { x: 44, y: y - 70, size: 9, font: regular, color: rgb(0.45, 0.5, 0.5) });
  for (let i = 0; i < 10; i++) {
    const v = i / 9;
    page.drawRectangle({ x: 44 + i * 50, y: y - 158, width: 44, height: 70, color: rgb(v, v, v) });
    page.drawText(`${Math.round(v * 100)}%`, { x: 48 + i * 50, y: y - 178, size: 8, font: regular, color: rgb(0.45, 0.5, 0.5) });
  }
  log.info('generated test page');
  return pdf.save();
}

/* ---------------- QR pairing card ---------------- */

async function qrCardPdf({ title, url, lines = [] }) {
  const png = await QRCode.toBuffer(url, { width: 900, margin: 1, errorCorrectionLevel: 'M' });
  const pdf = await PDFDocument.create();
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage(A4);
  const { width, height } = page.getSize();

  page.drawRectangle({ x: 0, y: height - 150, width, height: 150, color: rgb(0.04, 0.24, 0.23) });
  page.drawText(title || 'PrintBridge', { x: 44, y: height - 78, size: 34, font: bold, color: rgb(1, 1, 1) });
  page.drawText('Scan to upload & print', { x: 44, y: height - 112, size: 14, font: regular, color: rgb(0.72, 0.95, 0.9) });

  const image = await pdf.embedPng(png);
  const size = 400;
  page.drawImage(image, { x: (width - size) / 2, y: height - 150 - size - 70, width: size, height: size });

  let y = height - 150 - size - 130;
  page.drawText(url, { x: 44, y, size: 12, font: regular, color: rgb(0.25, 0.3, 0.3) });
  y -= 34;
  for (const line of lines) {
    page.drawText(line, { x: 44, y, size: 11, font: regular, color: rgb(0.35, 0.4, 0.4) });
    y -= 20;
  }
  page.drawText('No app needed · works from any phone or laptop on this network', {
    x: 44, y: 60, size: 9.5, font: regular, color: rgb(0.5, 0.55, 0.55),
  });
  log.info('generated QR pairing card');
  return pdf.save();
}

module.exports = { officeToPdf, hasOfficeSupport, testPagePdf, qrCardPdf };
