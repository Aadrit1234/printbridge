'use strict';
/* Windows-specific helpers: spooler introspection and locating (or installing)
 * a silent print engine. Windows has no built-in CLI that prints a PDF to a
 * named queue, so we drive SumatraPDF (preferred) or Adobe Reader. */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const log = require('../../logger').make('windows');

const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

function runPowerShell(script, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const full = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`;
    execFile('powershell.exe', [...PS_FLAGS, full], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error((stderr || err.message || '').trim().slice(0, 300) || 'PowerShell command failed'));
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
  });
}

function runFile(file, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        error: err ? err.message : null,
        stdout: String(stdout || ''), stderr: String(stderr || ''),
      }));
  });
}

/* ---------------- spooler queues ---------------- */

const PORT_KIND = (port) => {
  const p = String(port || '').toUpperCase();
  if (/^(USB|DOT4)/.test(p)) return 'usb';
  if (/^(IP_|WSD|LPR|\\\\)/.test(p) || /^https?:/i.test(p)) return 'network';
  return 'local';
};

const STATUS_MAP = { 0: 'ready', 3: 'ready', 2: 'unknown', 4: 'busy', 5: 'busy', 6: 'error', 7: 'offline', 1: 'unknown' };

/** Nudge the HP Neverstop (and similar) queues to the top of the list. */
function scoreQueue(q) {
  let score = 0;
  const text = `${q.name} ${q.driver}`.toLowerCase();
  if (/neverstop/.test(text)) score += 100;
  if (/1200|12\d\d/.test(text)) score += 30;
  if (/\bhp\b|hewlett/.test(text)) score += 25;
  if (/laser|laserjet|mfp/.test(text)) score += 10;
  if (q.kind === 'usb') score += 15;
  if (/microsoft print to pdf|onenote|fax|xps/i.test(text)) score -= 200;
  return score;
}

async function listQueues() {
  if (process.platform !== 'win32') return [];
  const { stdout } = await runPowerShell(
    'Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus,Type | ConvertTo-Json -Compress -Depth 3',
    20000
  );
  let parsed;
  try { parsed = JSON.parse(stdout.trim() || '[]'); } catch { return []; }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter(Boolean).map(q => ({
    id: q.Name,
    name: q.Name,
    driver: q.DriverName || '',
    port: q.PortName || '',
    kind: PORT_KIND(q.PortName),
    status: STATUS_MAP[q.PrinterStatus] || 'unknown',
  })).sort((a, b) => scoreQueue(b) - scoreQueue(a));
}

async function queueJobCount(name) {
  if (process.platform !== 'win32' || !name) return null;
  try {
    const safe = String(name).replace(/'/g, "''");
    const { stdout } = await runPowerShell(
      `(Get-PrintJob -PrinterName '${safe}' -ErrorAction SilentlyContinue | Measure-Object).Count`,
      12000
    );
    const n = parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/* ---------------- silent print engines ---------------- */

function candidatePaths() {
  const env = process.env;
  return [
    path.join(process.cwd(), 'tools', 'SumatraPDF.exe'),
    path.join(__dirname, '..', '..', '..', 'tools', 'SumatraPDF.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'SumatraPDF', 'SumatraPDF.exe'),
    env.APPDATA && path.join(env.APPDATA, 'SumatraPDF', 'SumatraPDF.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'SumatraPDF.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'SumatraPDF', 'SumatraPDF.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'SumatraPDF', 'SumatraPDF.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'SumatraPDF', 'SumatraPDF-3.5.2-64.exe'),
  ].filter(Boolean);
}

async function findSumatra() {
  for (const p of candidatePaths()) {
    try { if (fs.existsSync(p)) return p; } catch { /* skip */ }
  }
  const res = await runFile('where.exe', ['SumatraPDF.exe'], { timeoutMs: 8000 });
  const hit = res.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
  return hit && fs.existsSync(hit) ? hit : null;
}

async function findAdobe() {
  const env = process.env;
  const candidates = [
    env.ProgramFiles && path.join(env.ProgramFiles, 'Adobe', 'Acrobat DC', 'Acrobat', 'Acrobat.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Adobe', 'Acrobat Reader DC', 'Reader', 'AcroRd32.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Adobe', 'Acrobat Reader DC', 'Reader', 'AcroRd32.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Adobe', 'Acrobat DC', 'Acrobat', 'Acrobat.exe'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* skip */ }
  }
  const res = await runFile('where.exe', ['AcroRd32.exe'], { timeoutMs: 8000 });
  const hit = res.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
  return hit && fs.existsSync(hit) ? hit : null;
}

async function toolsStatus() {
  const [sumatra, adobe, winget] = await Promise.all([
    findSumatra(),
    findAdobe(),
    runFile('where.exe', ['winget.exe'], { timeoutMs: 8000 }).then(r => r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean) || null),
  ]);
  return { sumatra, adobe, winget, ready: Boolean(sumatra || adobe) };
}

/** Install SumatraPDF — winget first, then the portable zip from GitHub. */
async function installSumatra(report = () => {}) {
  const steps = [];
  const say = (msg) => { steps.push(msg); report(msg); log.info(msg); };

  const existing = await findSumatra();
  if (existing) return { ok: true, path: existing, via: 'already-installed', steps };

  const before = await toolsStatus();
  if (before.winget) {
    say('Trying winget (SumatraPDF.SumatraPDF)…');
    const res = await runFile(before.winget, [
      'install', '--id', 'SumatraPDF.SumatraPDF', '-e', '--silent',
      '--accept-package-agreements', '--accept-source-agreements',
      '--disable-interactivity',
    ], { timeoutMs: 300000 });
    const found = await findSumatra();
    if (found) { say('Installed via winget.'); return { ok: true, path: found, via: 'winget', steps }; }
    say(`winget did not complete (exit ${res.code}). ${(res.stderr || res.stdout || '').trim().split('\n').slice(-2).join(' ').slice(0, 200)}`);
  } else {
    say('winget not available — falling back to the portable download.');
  }

  try {
    say('Downloading the portable build from GitHub…');
    const rel = await fetch('https://api.github.com/repos/sumatrapdfreader/sumatrapdf/releases/latest', {
      headers: { 'user-agent': 'PrintBridge' },
    }).then(r => r.json());
    const asset = (rel.assets || []).find(a => /\.zip$/i.test(a.name) && /64|portable/i.test(a.name))
      || (rel.assets || []).find(a => /\.zip$/i.test(a.name));
    if (!asset) throw new Error('no portable zip asset found in the latest release');

    const toolsDir = path.join(process.cwd(), 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    const zipPath = path.join(toolsDir, 'sumatra.zip');
    const buf = Buffer.from(await fetch(asset.browser_download_url).then(r => r.arrayBuffer()));
    await fsp.writeFile(zipPath, buf);
    say(`Downloaded ${(buf.length / 1048576).toFixed(1)} MB.`);

    await runPowerShell(`Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${toolsDir.replace(/'/g, "''")}' -Force`, 120000);
    await fsp.unlink(zipPath).catch(() => {});
    const found = await findSumatra();
    if (found) { say('Portable copy ready.'); return { ok: true, path: found, via: 'portable-download', steps }; }
    throw new Error('SumatraPDF.exe not found after extraction');
  } catch (e) {
    say(`Portable download failed: ${e.message}`);
    return {
      ok: false,
      via: null,
      steps,
      hint: 'Install SumatraPDF manually from https://www.sumatrapdfreader.org/download-free-pdf-viewer, or install Adobe Acrobat Reader, then press Retry.',
    };
  }
}

module.exports = {
  runPowerShell, runFile, listQueues, queueJobCount,
  findSumatra, findAdobe, toolsStatus, installSumatra,
  scoreQueue, osHome: os.homedir(),
};
