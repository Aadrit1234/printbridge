'use strict';
/* PrintBridge desktop — the console core, shared by the machine and shop apps.
 *
 * It does three things a browser tab cannot:
 *
 *   1. It runs the server — the machine's app only (profile.supervises). The
 *      window is not the product; the print service is, and this process owns
 *      its lifetime so a shop never has to open a terminal.
 *   2. It shows the console: the machine's own operations, and — in the shop's
 *      app — the business on top of them.
 *   3. It keeps itself alive: start with Windows, survive a closed window (it
 *      hides to the tray), stay awake while jobs are in flight, and update
 *      itself.
 *
 * Two ways to run, and both are normal:
 *   • the machine's app → no server on the port? Start one as a child process
 *     and stop it when the app quits. A server already there (a terminal
 *     `npm start`, a second launch)? Attach to it, rather than opening a second
 *     copy on ports 8089, 8090…
 *   • the shop's app → no service at all. Its window talks to a machine it found
 *     on the network through the same loopback host, and its business panels
 *     keep working when that machine is not reachable.
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

/* The version of *this* app, not of Electron. Under `electron desktop/apps/x`
 * there is no package.json beside the main script, so app.getVersion() answers
 * with Electron's own version (33.x) and the app then claims the running service
 * is a different build than itself. Read the real one in a dev run. */
const APP_VERSION = app.isPackaged
  ? app.getVersion()
  : require('../../package.json').version;
const host = require('./host');
const log = require('./log');
const machines = require('./machines');
const nearby = require('./nearby');
const shopStore = require('./shop-store');

const DEV = !app.isPackaged;
const ROOT = path.join(__dirname, '..', '..');
/* Which of the three apps this is. Set by start(); nothing here works without it. */
let profile = null;
const PREFERRED_PORT = parseInt(process.env.PORT, 10) || 8088;
const PORT_TRIES = 12;

/* A packaged build cannot write next to its own files (Program Files is not a
 * data directory), so it keeps jobs, printers and the console sign-in under the user
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
let adminPassword = null; // in memory only, for the self-test; never written down

/* ---------------------------------------------------------------- logging */

/** The log file lives beside this app's data — one per app, never shared. */
function logFile() {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'printbridge.log');
  } catch {
    return null;
  }
}

let logStarted = false;

function push(line) {
  if (!logStarted) {
    logStarted = true;
    log.init({ filePath: logFile() });
  }
  const written = log.write(line);
  if (win && !win.isDestroyed()) win.webContents.send('pb:log', written);
  return written;
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
    title: profile.windowTitle,
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

const PANEL_LABELS = {
  connection: 'Machines',
  setup: 'Setup',
  queue: 'Queue',
  codes: 'Print codes',
  printers: 'Printers',
  printer: 'Printer connection',
  pricing: 'Pricing',
  expenses: 'Expenses',
  reports: 'Revenue & reports',
  settings: 'Settings',
  access: 'Access',
  account: 'Account',
};

/* A menu item for a panel this app does not have is worse than no menu item:
 * it teaches people the app is broken. The list comes from the profile. */
function panelMenu() {
  return [
    ...profile.panels.map((name, index) => ({
      label: PANEL_LABELS[name] || name,
      accelerator: index < 9 ? `CmdOrCtrl+${index + 1}` : undefined,
      click: () => go(`#/${name}`),
    })),
    { type: 'separator' },
    { label: 'The guest print page', click: () => openGuest('print') },
    { label: 'The public site', click: () => openGuest('') },
  ];
}

/** Switch which machine the console is looking at. */
function useMachine(machine) {
  /* Hand the whole machine over, not just its id: `use` remembers what it is
   * given, so collapsing it to an address here loses the name, tier and version
   * the picker just learned — and the machine comes back named "127.0.0.1:8097". */
  const saved = machines.use(machine);
  if (!saved) return null;
  note(`working with ${saved.name} (${saved.id})`);
  if (win && !win.isDestroyed()) win.reload();
  return saved;
}

/** The machine the console is pointed at, in the menu, where you look for it. */
function machineMenu() {
  const now = machines.current();
  const known = machines.list().slice(0, 8);
  return {
    label: 'Machine',
    submenu: [
      { label: now ? `Working with ${now.name}` : 'No machine chosen yet', enabled: false },
      { type: 'separator' },
      { label: 'Find machines on this network', click: () => go('#/connection') },
      ...(known.length
        ? [{ type: 'separator' }, ...known.map(m => ({
          label: `${now && now.id === m.id ? '● ' : ''}${m.name}`,
          tooltip: m.id,
          click: () => useMachine(m),
        }))]
        : []),
    ],
  };
}

function buildMenu() {
  const awake = () => Boolean(keepAwakeBlocker && powerSaveBlocker.isStarted(keepAwakeBlocker));
  const template = [
    {
      label: 'PrintBridge',
      submenu: [
        { label: `Version ${APP_VERSION}${DEV ? ' (dev)' : ''}`, enabled: false },
        { type: 'separator' },
        {
          label: 'Open data folder',
          click: () => shell.openPath(DATA_DIR),
        },
        {
          label: 'Open log file',
          click: () => {
            const file = log.path();
            if (file) shell.openPath(file);
          },
        },
        { type: 'separator' },
        { label: 'Quit PrintBridge', accelerator: 'CmdOrCtrl+Q', click: () => quit() },
      ],
    },
    {
      label: 'Panels',
      submenu: panelMenu(),
    },
    ...(profile.picksMachine ? [machineMenu()] : []),
    ...(profile.supervises ? [{
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
    }] : []),
    {
      label: 'Tools',
      submenu: [
        ...(profile.supervises ? [{
          label: 'Run the real self-test',
          click: () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); win.webContents.send('pb:run-selftest'); } },
        }, { type: 'separator' }] : []),
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
            detail: `${DATA_DIR}\n\nThe console sign-in is stored here as a hash — the password cannot be read back, only reset. Delete access.json to reset it, and a new username and password will be printed on the next start.`,
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
  tray.setToolTip(`PrintBridge ${profile.role === 'machine' ? `— print service on port ${serverPort}` : `— ${profile.productName}`}`);
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
  const env = { BASE: base, DATA_DIR, ADMIN_PASSWORD: adminPassword || '' };
  const report = [];
  report.push(`service: ${base} (${startedByUs ? 'started by this app' : 'already running'})`);
  report.push(`data directory: ${DATA_DIR}`);
  report.push(adminPassword ? 'console sign-in: held in memory for this run' : 'console sign-in: not available — sign in first, then run this');

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
 * own browser), never in the console window where the machine session lives. */
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
    version: APP_VERSION,
    startedByUs,
    keepAwake: Boolean(keepAwakeBlocker),
    autostart: autostartEnabled(),
    /* Which app this is decides what the console shows: a shop's app has
     * pricing, expenses and revenue, a machine's app has setup and diagnostics.
     * The renderer reads this and renders only what belongs to it. */
    profile: {
      id: profile.id,
      role: profile.role,
      productName: profile.productName,
      tagline: profile.tagline,
      panels: profile.panels,
      home: profile.home,
      console: profile.console,
      supervises: profile.supervises,
      picksMachine: profile.picksMachine,
      offlineHint: profile.offlineHint,
    },
    machine: machines.current(),
  }));

  /* ---------------- machines (the shop and client apps) ---------------- */

  ipcMain.handle('pb:machines:list', () => ({
    current: machines.current(),
    known: machines.list(),
  }));

  ipcMain.handle('pb:machines:discover', async () => {
    const found = await nearby.browse({ timeoutMs: 2600 });
    /* Confirm each one actually answers, and learn what it is while we are
     * there: an mDNS record can outlive the machine that published it. */
    const checked = await Promise.all(found.map(async (machine) => {
      const alive = await nearby.confirm(machine.host, machine.port).catch(() => ({ ok: false }));
      /* Every row needs an id to be clickable, whatever the browse returned. */
      const addr = machines.address(machine);
      return {
        ...machine,
        ...alive,
        id: addr ? machines.idFor(addr) : '',
        /* Found, not typed: keep it that way when it is chosen. */
        source: 'mdns',
        reachable: Boolean(alive.ok),
      };
    }));
    /* Count what answered, not what was seen: an mDNS record outlives the
     * machine, and "3 answered" over a list of unreachable rows reads as a lie. */
    push(`network scan: ${checked.length} machine(s) on the network, ${checked.filter(m => m.reachable).length} answering`);
    return { current: machines.current(), found: checked, known: machines.list() };
  });

  ipcMain.handle('pb:machines:check', async (event, address) => {
    const parsed = machines.address(address);
    if (!parsed) return { ok: false, reason: 'That is not an address I can use' };
    const alive = await nearby.confirm(parsed.host, parsed.port).catch(() => ({ ok: false }));
    if (!alive.ok) return { ok: false, reason: alive.reason || 'nothing answered' };
    const saved = machines.remember({
      ...parsed,
      name: (address && address.name) || alive.hostname || parsed.host,
      version: alive.version,
      source: 'manual',
    }, { lastSeen: new Date().toISOString() });
    buildMenu();
    return { ok: true, machine: saved, app: alive.app, version: alive.version };
  });

  ipcMain.handle('pb:machines:use', (event, machine) => {
    const saved = useMachine(machine);
    return saved ? { ok: true, machine: saved } : { ok: false, error: 'That does not look like an address' };
  });

  ipcMain.handle('pb:machines:forget', (event, id) => ({ ok: machines.forget(String(id || '')) }));

  /* ---------------- the shop's own document (local first) ---------------- */

  ipcMain.handle('pb:shop:load', (event, accountId) => {
    if (!shopStore.safeId(accountId)) return { ok: false, error: 'No account signed in' };
    return { ok: true, ...shopStore.load(accountId) };
  });

  ipcMain.handle('pb:shop:save', (event, accountId, state) => {
    if (!shopStore.safeId(accountId)) return { ok: false, error: 'No account signed in' };
    const result = shopStore.save(accountId, state);
    return result === true ? { ok: true, savedAt: new Date().toISOString() } : { ok: false, error: (result && result.error) || 'could not write the local copy' };
  });

  /* Which licence used this computer. A shop whose machine is switched off still
   * has its books here; this is how it finds them without asking the machine. */
  ipcMain.handle('pb:shop:account:remember', (event, account, machineId) => ({
    ok: shopStore.rememberAccount(account || {}, String(machineId || '')),
  }));

  ipcMain.handle('pb:shop:account:last', (event, machineId) => shopStore.lastAccount(String(machineId || '')));

  ipcMain.handle('pb:server:restart', async () => {
    const meta = await restartServer();
    return { ok: Boolean(meta), port: serverPort };
  });

  ipcMain.handle('pb:open-data', () => shell.openPath(DATA_DIR));
  ipcMain.handle('pb:open-external', (event, url) => shell.openExternal(String(url)));
  ipcMain.handle('pb:password', (event, password) => { adminPassword = String(password || '') || null; return true; });
  ipcMain.handle('pb:selftest', () => (profile.supervises
    ? selfTest()
    : { ok: false, lines: ['This app talks to a printer machine; its own suites run in the machine\'s app.'] }));
  ipcMain.handle('pb:logs:get', () => ({ lines: log.tail(400), file: log.path() }));
  ipcMain.handle('pb:logs:clear', () => { log.clear(); return true; });
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

/**
 * Start one of the console apps.
 *
 * The profile says which: the machine's app runs the print service here, the
 * shop's app points the same console at a machine on the network and keeps the
 * business panel working when that machine is away. Everything else — the
 * window, the host, the tray, updates, the panel routes — is shared.
 */
function start(appProfile) {
  profile = appProfile;
  /* Each app keeps its own user-data folder. Machines, the local copy of the
   * shop's books and the log must never be shared between a machine's app and a
   * client's — they are different products on the same PC. */
  app.setName(profile.productName);
  /* …and the path has to be set, not just the name.
   *
   * In a packaged build Electron has already worked out `userData` from
   * package.json's `name` by the time this runs, so `setName` alone left all
   * three apps writing into one folder — `%APPDATA%/printbridge` — sharing one
   * machines list, one console sign-in and one set of books. A shop's app
   * installed beside a machine's app would read the other one's data. Naming the
   * path explicitly is the difference between "each app has its own data" being
   * a comment and being true. */
  try {
    app.setPath('userData', path.join(app.getPath('appData'), profile.productName));
  } catch { /* an unwritable profile is not worth refusing to start over */ }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }

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
    app.setAppUserModelId(profile.appId);
    machines.init({ userData: app.getPath('userData') });
    shopStore.init({ userData: app.getPath('userData') });
    wireIpc();
    buildMenu();

    try {
      if (profile.supervises) {
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
        if (meta.version !== APP_VERSION) {
          note(`note: the running service is ${meta.version} and this app is ${APP_VERSION} — restart the service from the app to bring them together`);
        }
      } else {
        /* The shop's app runs no service of its own. Its window shows a machine
         * on the network — and shows its own business panels when that machine
         * is not there, which is the whole point of the local copy. */
        const machine = machines.current();
        note(machine
          ? `console pointed at ${machine.name} (${machine.id})`
          : 'no machine chosen yet — the Machines panel is where that happens');
      }

      /* The interface host: the window points here, and everything except the
       * console itself is proxied — to this machine's own service, or to the
       * machine this app has been pointed at. */
      appHost = await host.start({
        root: path.join(__dirname, '..', 'renderer'),
        publicDir: path.join(ROOT, 'public'),
        target: () => (profile.supervises
          ? (serverPort ? { host: '127.0.0.1', port: serverPort } : null)
          : machines.target()),
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

  return true;
}

module.exports = { start };

