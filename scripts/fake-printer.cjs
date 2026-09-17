/* A tiny IPP printer that lives on localhost.
 *
 * PrintBridge's Wi-Fi path is IPP, and a real printer is the one thing a test
 * cannot assume you own. This stands in for it: it answers
 * Get-Printer-Attributes, accepts Print-Job, and prints what it received as one
 * JSON line per request, so a script can assert on the media, sides, copies and
 * document bytes that actually left the server.
 *
 *   node scripts/fake-printer.cjs                  # listens on 127.0.0.1:8631
 *   PORT=8632 node scripts/fake-printer.cjs
 *   REJECT_OPTIONS=1 node scripts/fake-printer.cjs # refuses print-scaling etc.
 *   WEDGE=1 node scripts/fake-printer.cjs          # accepts, answers nothing (asleep)
 *   NAME="HP Neverstop" node scripts/fake-printer.cjs
 *
 * Point PrintBridge at it with the printer address 127.0.0.1:8631
 * (Admin → Printer → Network), or run scripts/smoke-ipp.cjs, which wires the
 * whole thing up automatically.
 */
'use strict';

const http = require('http');
const ipp = require('ipp');

/* The bundled attribute table is from an older IANA snapshot; add the few
 * printer attributes this simulator reports (the serializer refuses unknowns).
 * src/services/backends/ipp.js does the same for print-scaling on the client. */
(function extendAttributeTable() {
  const table = require('ipp/lib/attributes')['Printer Description'];
  const keywordSet = table['sides-supported'];
  table['marker-levels'] = { ...table['printer-up-time'], setof: true };
  table['marker-names'] = { ...table['printer-name'], setof: true };
  table['print-scaling-supported'] = keywordSet;
})();

const PORT = parseInt(process.env.PORT, 10) || 8631;
const NAME = process.env.NAME || 'Fake Neverstop 1200w';
const REJECT_OPTIONS = process.env.REJECT_OPTIONS === '1';
const WEDGE = process.env.WEDGE === '1';
const OPTIONAL = ['print-scaling', 'sides', 'print-quality', 'print-color-mode'];

let jobId = 0;
let processing = 0;

function report(entry) {
  process.stdout.write(`PRINTER ${JSON.stringify(entry)}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) { req.destroy(); return reject(new Error('too large')); }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function printerAttributes(state) {
  return {
    'printer-name': NAME,
    'printer-make-and-model': `${NAME} (simulated)`,
    'printer-state': state,
    'printer-state-reasons': ['none'],
    'printer-state-message': state === 'processing' ? 'Printing' : 'Ready to print',
    'queued-job-count': processing,
    'media-default': 'iso_a4_210x297mm',
    'print-scaling-supported': ['auto', 'auto-fit', 'fit', 'fill', 'none'],
    'sides-supported': ['one-sided', 'two-sided-long-edge'],
    'marker-names': ['Black cartridge'],
    'marker-levels': [42],
  };
}

/** PDFs start with %PDF — good enough to prove the document bytes came through. */
function documentInfo(body, parsed) {
  const marker = body.indexOf('%PDF');
  if (marker === -1) return { docBytes: Buffer.byteLength(String(parsed.data || ''), 'utf8'), docLooksLikePdf: false };
  return { docBytes: body.length - marker, docLooksLikePdf: true };
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }

  const body = await readBody(req).catch(() => Buffer.alloc(0));
  if (WEDGE) {
    // Connected but silent, like a printer that dozed off with the socket open.
    report({ at: new Date().toISOString(), operation: 'wedged', bytes: body.length });
    return;
  }

  let parsed;
  try {
    parsed = ipp.parse(body);
  } catch (e) {
    res.writeHead(400).end();
    report({ at: new Date().toISOString(), operation: 'unparsable', error: e.message });
    return;
  }

  const operation = parsed.operation;
  const jobAttrs = parsed['job-attributes-tag'] || {};
  const doc = documentInfo(body, parsed);

  const base = {
    version: '2.0',
    id: parsed.id,
    'operation-attributes-tag': {
      'attributes-charset': 'utf-8',
      'attributes-natural-language': 'en-us',
    },
  };

  let response;

  if (operation === 'Get-Printer-Attributes' || operation === 'Validate-Job') {
    response = { ...base, statusCode: 'successful-ok', 'printer-attributes-tag': printerAttributes(processing ? 'processing' : 'idle') };
    report({ at: new Date().toISOString(), operation, requested: parsed['operation-attributes-tag'] && parsed['operation-attributes-tag']['requested-attributes'] || 'all' });
  } else if (operation === 'Print-Job') {
    const refused = REJECT_OPTIONS ? OPTIONAL.filter(name => jobAttrs[name] !== undefined) : [];
    if (refused.length) {
      response = {
        ...base,
        statusCode: 'client-error-attributes-or-values-not-supported',
        'operation-attributes-tag': {
          ...base['operation-attributes-tag'],
          'status-message': `unsupported: ${refused.join(',')}`,
        },
      };
      report({ at: new Date().toISOString(), operation, refused, accepted: false });
    } else {
      jobId += 1;
      processing += 1;
      response = {
        ...base,
        statusCode: 'successful-ok',
        'job-attributes-tag': { 'job-id': jobId, 'job-uri': `ipp://127.0.0.1:${PORT}/ipp/print/${jobId}`, 'job-state': 'pending' },
        'printer-attributes-tag': printerAttributes('processing'),
      };
      report({
        at: new Date().toISOString(),
        operation,
        accepted: true,
        printerJobId: jobId,
        name: jobAttrs['job-name'] || (parsed['operation-attributes-tag'] || {})['job-name'] || null,
        documentFormat: (parsed['operation-attributes-tag'] || {})['document-format'] || null,
        media: jobAttrs.media || null,
        sides: jobAttrs.sides || null,
        printScaling: jobAttrs['print-scaling'] || null,
        printQuality: jobAttrs['print-quality'] || null,
        copies: jobAttrs.copies || 1,
        ...doc,
      });
      setTimeout(() => { processing = Math.max(0, processing - 1); }, 400).unref();
    }
  } else if (operation === 'Cancel-Job') {
    response = { ...base, statusCode: 'successful-ok' };
    report({ at: new Date().toISOString(), operation, printerJobId: (parsed['operation-attributes-tag'] || {})['job-id'] || null });
  } else {
    // Anything else (Identify-Printer, Get-Jobs…) is politely supported.
    response = { ...base, statusCode: 'successful-ok' };
    report({ at: new Date().toISOString(), operation, note: 'accepted without action' });
  }

  const buf = ipp.serialize(response);
  res.writeHead(200, { 'Content-Type': 'application/ipp', 'Content-Length': buf.length });
  res.end(buf);
});

server.listen(PORT, '127.0.0.1', () => {
  report({ at: new Date().toISOString(), listening: `http://127.0.0.1:${PORT}/ipp/print`, name: NAME, rejectOptions: REJECT_OPTIONS, wedge: WEDGE });
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
