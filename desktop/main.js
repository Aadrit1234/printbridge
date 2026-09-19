'use strict';
/* PrintBridge desktop — the app you run on the laptop that owns the printer.
 *
 * It does three things a browser tab cannot:
 *
 *   1. It runs the server. The window is not the product; the print service is,
 *      and this process owns its lifetime so a shop never has to open a terminal.
 *   2. It shows the setup console (/desktop) — find the printer, adopt it, give
 *      it a code, print a sticker, prove it with a real test.
 *   3. It keeps itself alive: start with Windows, survive a closed window
 *      (it hides to the tray), and stay awake while jobs are in flight.
 *
 * Two ways to run, and both are normal:
 *   • no server on the port  → we start one as a child process and stop it when
 *     the app quits;
 *   • a server already there → we attach to it (a terminal `npm start`, or a
 *     second launch) rather than starting a second copy on ports 8089, 8090…
 *
 * The child is spawned as Node (ELECTRON_RUN_AS_NODE), so the server code is
 * exactly the code the tests run against — no Electron in the print path.
 */

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const {
  app, BrowserWindow, Menu, Tray, shell, ipcMain, dialog, powerSaveBlocker, nativeImage,
} = require('electron');
const host = require('./host');

const DEV = !app.isPackaged;
const ROOT = path.join(__dirname, '..');
const PREFERRED_PORT = parseInt(process.env.PORT, 10) || 8088;
const PORT_TRIES = 12;
const LOG_LIMIT = 900;

/* A packaged build cannot write next to its own files (Program Files is not a
 * data directory), so it keeps jobs, printers and the PIN under the user
 * profile. A dev run uses ./data, the same place the tests use — unless
 * DATA_DIR says otherwise, which is how you point the app at a scratch folder
 * without touching a live install's jobs and printers. */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : (DEV ? path.join(ROOT, 'data') : path.join(app.getPath('userData'), 'data'));

let win = null;
let tray = null;
let server = null;
let serverPort = null;
/* The app's own interface host (desktop/host.js): serves the console from disk
 * and proxies /api, /print, /owner… to the print service. The window is pointed
 * at this, never at the service directly — which is why the console is no
 * longer reachable over the network at all. */
let appHost = null;
let updater = null;
let updateState = { kind: 'off' };
let startedByUs = false;
let quitting = false;
let keepAwakeBlocker = null;
let adminPin = null; // in memory only, for the self-test; never written down
const lines = [];

/* ---------------------------------------------------------------- logging */

function logFile() {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'printbridge.log');
  } catch {
    return null;
  }
}

function push(line) {
  const clean = String(line).replace(/\s+$/, '');
  if (!clean) return;
  const stamp = new Date().toISOString().slice(11, 19);
  lines.push(`[${stamp}] ${clean}`);
  if (lines.length > LOG_LIMIT) lines.splice(0, lines.length - LOG_LIMIT);
  if (win && !win.isDestroyed()) win.webContents.send('pb:log', `[${stamp}] ${clean}`);
  const file = logFile();
  if (file) { try { fs.appendFileSync(file, `${new Date().toISOString()} ${clean}\n`); } catch { /* best effort */ } }
}

function note(message) {
  push(message);
  console.log(message);
}

/* ---------------------------------------------------------------- server */

/** Is there already a PrintBridge answering here? */
async function probe(port) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 700);
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/system/meta`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const meta = await res.json();
    /* The guest surface calls it appName, the admin surface calls it app; a
       version in the body is the reliable sign that a PrintBridge answered. */
    return meta && (meta.appName || meta.app) && meta.version ? meta : null;
  } catch {
    return null;
  }
}

async function pickPort() {
  for (let i = 0; i < PORT_TRIES; i++) {
    const port = PREFERRED_PORT + i;
    // eslint-disable-next-line no-await-in-loop
    const meta = await probe(port);
    if (meta) return { port, external: true, meta };
    // eslint-disable-next-line no-await-in-loop
    const free = await portFree(port);
    if (free) return { port, external: false, meta: null };
  }
  throw new Error(`No free port between ${PREFERRED_PORT} and ${PREFERRED_PORT + PORT_TRIES}`);
}

function portFree(port) {
  return new Promise((resolve) => {
    const tester = require('net').createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '0.0.0.0');
  });
}

function startServer(port) {
  const entry = path.join(ROOT, 'server.js');
  note(`starting the print service on port ${port} (data: ${DATA_DIR})`);
  server = fork(entry, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      DATA_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  startedByUs = true;
  server.stdout.on('data', (chunk) => push(String(chunk)));
  server.stderr.on('data', (chunk) => push(String(chunk)));
  server.on('exit', (code, signal) => {
    note(`print service exited (${signal || code})`);
    server = null;
    if (!quitting) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('pb:server', { running: false, port: serverPort });
      }
      push('the service stopped — use Server ▸ Restart to bring it back');
    }
  });
  return server;
}

async function stopServer() {
  if (!server || !startedByUs) { note('nothing to stop (the service is not ours)'); return true; }
  note('stopping the print service');
  const child = server;
  server = null;
  return new Promise((resolve) => {
    const done = () => resolve(true);
    child.once('exit', done);
    try { child.kill(); } catch { done(); }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } done(); }, 4000);
  });
}

async function restartServer() {
  const port = serverPort;
  await stopServer();
  await new Promise((r) => setTimeout(r, 900));
  startServer(port);
  return waitForServer(port, 25000);
}

/** Poll until the server answers, so the window never opens onto a dead page. */
async function waitForServer(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const meta = await probe(port);
    if (meta) return meta;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/* ---------------------------------------------------------------- window */

function loadError(message) {
  const html = `<!doctype html><meta charset="utf-8">
    <body style="margin:0;background:#0b111d;color:#f2eee6;font:15px/1.6 'Segoe UI',system-ui,sans-serif;display:grid;place-items:center;height:100vh">
    <div style="max-width:520px;padding:32px">
      <h1 style="font:600 22px Georgia,serif;margin:0 0 12px">The print service did not start</h1>
      <p style="color:#c3cadd">${String(message).replace(/[<>&]/g, '')}</p>
      <p style="color:#8e9ab6;font-size:13px">Open <b>Server ▸ Log</b> in the menu bar to see why, then
      <b>Server ▸ Restart</b>. The log is also written next to the app's data folder.</p>
    </div></body>`;
  if (win && !win.isDestroyed()) win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function iconImage() {
  const candidates = [
    path.join(ROOT, 'public', 'assets', 'icon-192.png'),
    path.join(ROOT, 'public', 'assets', 'icon.png'),
    path.join(ROOT, 'public', 'assets', 'icon.svg'),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const image = nativeImage.createFromPath(file);
        if (!image.isEmpty()) return image;
      }
    } catch { /* try the next one */ }
  }
  return null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 940,
    minHeight: 660,
    show: false,
    backgroundColor: '#070a11',
    title: 'PrintBridge',
    icon: iconImage() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => push('interface loaded'));
  win.webContents.on('did-fail-load', (event, code, description, url) => {
    push(`could not load ${url} — ${description} (${code})`);
  });
  /* A fault in the interface must land in the same log as the service's, or a
   * blank panel on a shop counter is undiagnosable. */
  win.webContents.on('console-message', (event, level, message, line, source) => {
    if (level >= 2) push(`[ui:${level === 3 ? 'error' : 'warn'}] ${message}${source ? ` (${String(source).split('/').pop()}:${line})` : ''}`);
  });
  win.webContents.on('render-process-gone', (event, details) => {
    push(`the interface process stopped (${details && details.reason}) — reloading`);
    if (win && !win.isDestroyed()) win.reload();
  });
  win.on('close', (event) => {
    // Closing the window must not stop the print service: guests keep printing.
    if (!quitting && tray) {
      event.preventDefault();
      win.hide();
      if (process.platform === 'win32' && tray.displayBalloon) {
        try { tray.displayBalloon({ title: 'PrintBridge is still running', content: 'Guests can keep printing. Quit from the tray icon.' }); } catch { /* optional */ }
      }
    }
  });
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.includes('127.0.0.1') && !url.includes('localhost')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  win.loadURL(appHost ? appHost.url : 'about:blank');
}

/** Focus the window and switch panel, from the menu or the tray. */
function go(hash) {
  if (!win || win.isDestroyed()) return;
  win.show();
  win.focus();
  win.webContents.send('pb:navigate', hash);
}

/* ---------------------------------------------------------------- menu */

function buildMenu() {
  const awake = () => Boolean(keepAwakeBlocker && powerSaveBlocker.isStarted(keepAwakeBlocker));
  const template = [
    {
      label: 'PrintBridge',
      submenu: [
        { label: `Version ${app.getVersion()}${DEV ? ' (dev)' : ''}`, enabled: false },
        { type: 'separator' },
        {
          label: 'Open data folder',
          click: () => shell.openPath(DATA_DIR),
        },
        {
          label: 'Open log file',
          click: () => {
            const file = logFile();
            if (file) shell.openPath(file);
          },
        },
        { type: 'separator' },
        { label: 'Quit PrintBridge', accelerator: 'CmdOrCtrl+Q', click: () => quit() },
      ],
    },
    {
      label: 'Panels',
      submenu: [
        { label: 'Setup', accelerator: 'CmdOrCtrl+1', click: () => go('#/setup') },
        { label: 'Queue', accelerator: 'CmdOrCtrl+2', click: () => go('#/queue') },
        { label: 'Print codes', accelerator: 'CmdOrCtrl+3', click: () => go('#/codes') },
        { label: 'Printers', accelerator: 'CmdOrCtrl+4', click: () => go('#/printers') },
        { label: 'Printer connection', accelerator: 'CmdOrCtrl+5', click: () => go('#/printer') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+6', click: () => go('#/settings') },
        { label: 'Access', accelerator: 'CmdOrCtrl+7', click: () => go('#/access') },
        { label: 'Account', accelerator: 'CmdOrCtrl+8', click: () => go('#/account') },
        { type: 'separator' },
        { label: 'The guest print page', click: () => openGuest('print') },
        { label: 'The public site', click: () => openGuest('') },
      ],
    },
    {
      label: 'Server',
      submenu: [
        {
          label: 'Restart the print service',
          accelerator: 'CmdOrCtrl+R',
          click: async () => {
            const meta = await restartServer();
            if (win && !win.isDestroyed()) win.reload();
            note(meta ? 'service is back' : 'service did not answer after a restart');
          },
        },
        { label: 'Stop the service', click: () => stopServer() },
        {
          label: 'Start the service',
          click: () => {
            if (server) return;
            serverPort = serverPort || PREFERRED_PORT;
            startServer(serverPort);
          },
        },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Run the real self-test',
          click: () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); win.webContents.send('pb:run-selftest'); } },
        },
        { type: 'separator' },
        { label: 'Check for updates now', click: () => { checkForUpdates().catch(() => {}); } },
        { label: 'Restart to install the update', click: () => installUpdate(), enabled: false, id: 'menu-install-update' },
        { type: 'separator' },
        {
          label: 'Keep this laptop awake while printing',
          type: 'checkbox',
          checked: awake(),
          click: (item) => setKeepAwake(item.checked),
        },
        {
          label: 'Start when I sign in to Windows',
          type: 'checkbox',
          enabled: app.isPackaged,
          checked: autostartEnabled(),
          click: (item) => setAutostart(item.checked),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Open the guest page', click: () => openGuest('print') },
        { type: 'separator' },
        {
          label: 'Where is my data?',
          click: () => dialog.showMessageBox({
            type: 'info',
            title: 'PrintBridge data',
            message: 'Jobs, printers and settings',
            detail: `${DATA_DIR}\n\nThe PIN is stored here as a hash — it cannot be read back. Delete access.json to reset it and a new PIN will be printed on the next start.`,
            buttons: ['OK'],
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const image = iconImage();
  if (!image) return;
  try {
    tray = new Tray(image.resize({ width: 16, height: 16 }));
  } catch {
    return;
  }
  tray.setToolTip(`PrintBridge — print service on port ${serverPort}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open PrintBridge', click: () => { if (win) { win.show(); win.focus(); } else createWindow(); } },
    { label: 'Setup', click: () => go('#/setup') },
    { label: 'Queue', click: () => go('#/queue') },
    { type: 'separator' },
    { label: 'Restart the print service', click: () => restartServer().then(() => win && win.reload()) },
    { type: 'separator' },
    { label: 'Quit PrintBridge', click: () => quit() },
  ]));
  tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
}

/* ---------------------------------------------------------------- autostart & power */

function autostartEnabled() {
  if (!app.isPackaged) return false;
  try { return Boolean(app.getLoginItemSettings({ path: process.execPath }).openAtLogin); } catch { return false; }
}

function setAutostart(enabled) {
  if (!app.isPackaged) return false;
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: process.execPath, args: [] });
    note(`start with Windows: ${enabled ? 'on' : 'off'}`);
    return autostartEnabled();
  } catch (error) {
    note(`could not change the login item: ${error.message}`);
    return false;
  }
}

function setKeepAwake(enabled) {
  if (enabled && !keepAwakeBlocker) {
    keepAwakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
    note('holding the machine awake while the service runs');
  } else if (!enabled && keepAwakeBlocker) {
    try { powerSaveBlocker.stop(keepAwakeBlocker); } catch { /* already stopped */ }
    keepAwakeBlocker = null;
    note('released the keep-awake hold');
  }
  return Boolean(keepAwakeBlocker);
}

/* ---------------------------------------------------------------- self-test */

/** Run the project's own end-to-end suites against *this* service. */
function runSuite(script, env) {
  return new Promise((resolve) => {
    const out = [];
    let child;
    try {
      child = fork(path.join(ROOT, script), [], {
        cwd: ROOT,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (error) {
      resolve({ code: 1, out: [`could not start ${script}: ${error.message}`] });
      return;
    }
    const eat = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        out.push(line.trim());
        push(`[test] ${line.trim()}`);
      }
    };
    child.stdout.on('data', eat);
    child.stderr.on('data', eat);
    child.on('exit', (code) => resolve({ code: code === null ? 1 : code, out }));
  });
}

async function selfTest() {
  const base = `http://127.0.0.1:${serverPort}`;
  const env = { BASE: base, DATA_DIR, ADMIN_PIN: adminPin || '' };
  const report = [];
  report.push(`service: ${base} (${startedByUs ? 'started by this app' : 'already running'})`);
  report.push(`data directory: ${DATA_DIR}`);
  report.push(adminPin ? 'admin PIN: held in memory for this run' : 'admin PIN: not available — sign in on the Access step first');

  const suites = [
    ['API smoke', 'scripts/smoke.cjs'],
    ['Walk-up flows', 'scripts/smoke-walkup.cjs'],
  ];
  let ok = true;
  for (const [label, script] of suites) {
    report.push(`— ${label} —`);
    // eslint-disable-next-line no-await-in-loop
    const result = await runSuite(script, env);
    const tail = result.out.filter((line) => /pass|fail|error|✗|✔|—/.test(line)).slice(-14);
    report.push(...(tail.length ? tail : result.out.slice(-8)));
    if (result.code !== 0) ok = false;
  }
  report.push(ok ? 'all suites passed' : 'something failed — the log above has the detail');
  return { ok, lines: report };
}

/* ---------------------------------------------------------------- updates */

/* Self-updating, but only when it is honest about it: a packaged build checks
 * GitHub Releases, downloads in the background, and says so in the status strip.
 * A dev run never pretends an update exists. */
function broadcastUpdate(state) {
  updateState = state;
  if (win && !win.isDestroyed()) win.webContents.send('pb:update', state);
  const item = Menu.getApplicationMenu()?.getMenuItemById('menu-install-update');
  if (item) item.enabled = state.kind === 'ready';
}

function setupUpdates() {
  if (!app.isPackaged) {
    updateState = { kind: 'off' };
    push('updates: development run, the updater is off');
    return;
  }
  try {
    // eslint-disable-next-line global-require
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (error) {
    updateState = { kind: 'error', message: error.message };
    push(`updates: electron-updater is not available (${error.message})`);
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => broadcastUpdate({ kind: 'checking' }));
  updater.on('update-available', (info) => {
    push(`updates: version ${info && info.version} is available — downloading`);
    broadcastUpdate({ kind: 'available', version: info && info.version });
  });
  updater.on('update-not-available', () => broadcastUpdate({ kind: 'current' }));
  updater.on('download-progress', (p) => broadcastUpdate({ kind: 'downloading', percent: Math.round((p && p.percent) || 0) }));
  updater.on('update-downloaded', (info) => {
    push(`updates: ${info && info.version} is downloaded — it installs on the next restart`);
    broadcastUpdate({ kind: 'ready', version: info && info.version });
  });
  updater.on('error', (error) => {
    // A repo with no releases yet is the common case, not a fault.
    push(`updates: could not check (${error && error.message})`);
    broadcastUpdate({ kind: 'error', message: error && error.message });
  });
  updateState = { kind: 'current' };
  setTimeout(() => { checkForUpdates().catch(() => {}); }, 8000);
}

async function checkForUpdates() {
  if (!updater) return updateState;
  try {
    broadcastUpdate({ kind: 'checking' });
    await updater.checkForUpdates();
  } catch (error) {
    broadcastUpdate({ kind: 'error', message: error.message });
  }
  return updateState;
}

function installUpdate() {
  if (!updater || updateState.kind !== 'ready') return false;
  quitting = true;
  updater.quitAndInstall(false, true);
  return true;
}

/* ---------------------------------------------------------------- guest windows */

/* The guest page and the public site belong in a plain window (or the customer's
 * own browser), never in the console window where the PIN session lives. */
let guestWin = null;

function openGuest(view) {
  if (!appHost) return;
  const url = view === 'print' ? `${appHost.url}print/` : appHost.url;
  if (guestWin && !guestWin.isDestroyed()) {
    guestWin.loadURL(url);
    guestWin.show();
    guestWin.focus();
    return;
  }
  guestWin = new BrowserWindow({
    width: 520,
    height: 820,
    title: view === 'print' ? 'PrintBridge — print a document' : 'PrintBridge',
    backgroundColor: '#0e1524',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  guestWin.on('closed', () => { guestWin = null; });
  guestWin.loadURL(url);
}

/* ---------------------------------------------------------------- ipc */

function wireIpc() {
  ipcMain.handle('pb:info', () => ({
    port: serverPort,
    dataDir: DATA_DIR,
    packaged: app.isPackaged,
    version: app.getVersion(),
    startedByUs,
    keepAwake: Boolean(keepAwakeBlocker),
    autostart: autostartEnabled(),
  }));

  ipcMain.handle('pb:server:restart', async () => {
    const meta = await restartServer();
    return { ok: Boolean(meta), port: serverPort };
  });

  ipcMain.handle('pb:open-data', () => shell.openPath(DATA_DIR));
  ipcMain.handle('pb:open-external', (event, url) => shell.openExternal(String(url)));
  ipcMain.handle('pb:pin', (event, pin) => { adminPin = String(pin || '') || null; return true; });
  ipcMain.handle('pb:selftest', () => selfTest());
  ipcMain.handle('pb:logs:get', () => ({ lines: lines.slice(-400) }));
  ipcMain.handle('pb:logs:clear', () => { lines.length = 0; return true; });
  ipcMain.handle('pb:autostart:get', () => ({ supported: app.isPackaged, enabled: autostartEnabled() }));
  ipcMain.handle('pb:autostart:set', (event, enabled) => ({ supported: app.isPackaged, enabled: setAutostart(enabled) }));
  ipcMain.handle('pb:keepawake:get', () => ({ enabled: Boolean(keepAwakeBlocker) }));
  ipcMain.handle('pb:keepawake:set', (event, enabled) => ({ enabled: setKeepAwake(enabled) }));
  ipcMain.handle('pb:updates:status', () => updateState);
  ipcMain.handle('pb:updates:check', () => checkForUpdates());
  ipcMain.handle('pb:updates:install', () => installUpdate());
}

/* ---------------------------------------------------------------- lifecycle */

function quit() {
  quitting = true;
  if (win && !win.isDestroyed()) win.close();
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });

  app.on('window-all-closed', () => {
    // Windows/Linux: staying alive in the tray is the point.
    if (process.platform === 'darwin') app.quit();
  });

  app.on('before-quit', async (event) => {
    quitting = true;
    if ((server && startedByUs) || appHost) {
      event.preventDefault();
      if (appHost) { const closing = appHost; appHost = null; await closing.close().catch(() => {}); }
      await stopServer();
      app.quit();
    }
  });

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('app.printbridge.desktop');
    wireIpc();
    buildMenu();

    try {
      const choice = await pickPort();
      serverPort = choice.port;
      if (choice.external) {
        note(`attaching to the print service already running on port ${serverPort}`);
        startedByUs = false;
      } else {
        startServer(serverPort);
      }
      const meta = await waitForServer(serverPort, 30000);
      if (!meta) {
        createWindow();
        loadError(`Nothing answered on port ${serverPort} within 30 seconds.`);
        buildMenu();
        return;
      }
      note(`PrintBridge ${meta.version} is serving on ${meta.lanUrl || `http://127.0.0.1:${serverPort}`}`);
      if (meta.version !== app.getVersion()) {
        note(`note: the running service is ${meta.version} and this app is ${app.getVersion()} — restart the service from the app to bring them together`);
      }

      /* The interface host: the window points here, and everything except the
       * console itself is proxied to the service. */
      appHost = await host.start({
        root: path.join(__dirname, 'renderer'),
        publicDir: path.join(ROOT, 'public'),
        serverPort: () => serverPort,
        log: push,
      });

      createWindow();
      createTray();
      buildMenu();
      setupUpdates();
    } catch (error) {
      note(`startup failed: ${error.message}`);
      createWindow();
      loadError(error.message);
    }
  });
}

