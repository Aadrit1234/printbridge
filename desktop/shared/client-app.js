'use strict';
/* The customer's app — print, without a browser.
 *
 * It is a shell, and it is deliberately the *small* app of the three: two
 * windows and a tray.
 *
 *   1. Machines   the window it opens on. Lists the printer machines on this
 *                 network (they announce themselves, see src/services/nearby.js),
 *                 remembers the one you use, and takes an address by hand for a
 *                 machine that has to be reached across a tailnet or a VPN.
 *   2. Print      the machine's own print page in a window of its own — the
 *                 same page the QR code points at. Nothing is reimplemented
 *                 here, so the walk-up flow a shop has already tested is the
 *                 flow this app runs: code, upload, settings, pay, token.
 *
 * It runs no print service and holds no session: a customer's app has no
 * business being a control surface, and nothing here can change a machine.
 */

const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, Menu, Tray, shell, ipcMain, nativeImage,
} = require('electron');
const host = require('./host');
const log = require('./log');
const machines = require('./machines');
const nearby = require('./nearby');

const ROOT = path.join(__dirname, '..', '..');
const DEV = !app.isPackaged;

let profile = null;
let win = null;
let printWin = null;
let tray = null;
let appHost = null;
let quitting = false;

function logFile() {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'printbridge-client.log');
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

function iconImage() {
  for (const name of ['icon-512.png', 'icon-192.png', 'icon.png']) {
    try {
      const file = path.join(ROOT, 'public', 'assets', name);
      if (fs.existsSync(file)) {
        const image = nativeImage.createFromPath(file);
        if (!image.isEmpty()) return image;
      }
    } catch { /* try the next one */ }
  }
  return null;
}

/* ---------------------------------------------------------------- windows */

function createWindow() {
  win = new BrowserWindow({
    width: 620,
    height: 780,
    minWidth: 460,
    minHeight: 560,
    show: false,
    backgroundColor: '#070a11',
    title: profile.windowTitle,
    icon: iconImage() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload-client.js'),
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
  win.webContents.on('console-message', (event, level, message, line, source) => {
    if (level >= 2) push(`[ui:${level === 3 ? 'error' : 'warn'}] ${message}${source ? ` (${String(source).split('/').pop()}:${line})` : ''}`);
  });
  win.on('close', (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(appHost ? appHost.url : 'about:blank');
}

/** The print page of a machine, in a window of its own. */
function openPrint(machine, { code = '' } = {}) {
  const target = machine || machines.current();
  if (!target) return null;
  machines.remember(target.id || target, { lastSeen: new Date().toISOString() });
  const base = `http://${target.host}:${target.port}/print/`;
  push(`opening the print page at ${base}`);

  if (printWin && !printWin.isDestroyed()) {
    printWin.loadURL(base);
    printWin.show();
    printWin.focus();
    return printWin;
  }

  printWin = new BrowserWindow({
    width: 540,
    height: 860,
    minWidth: 420,
    minHeight: 600,
    title: `${profile.windowTitle} — ${target.name || target.host}`,
    backgroundColor: '#0e1524',
    autoHideMenuBar: true,
    icon: iconImage() || undefined,
    /* No preload and no node: this window renders a page served by somebody
     * else's machine, and it must stay exactly as far away from this computer
     * as any other web page would be. */
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: true,
      webSecurity: true,
    },
  });
  printWin.on('closed', () => { printWin = null; });
  printWin.webContents.on('did-fail-load', (event, code, description, url) => {
    push(`the print page did not load (${description} ${code}): ${url}`);
  });
  printWin.loadURL(base);
  return printWin;
}

function focusMain() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  if (!appHost) return;
  createWindow();
}

/* ---------------------------------------------------------------- menu */

function buildMenu() {
  const now = machines.current();
  const known = machines.list().slice(0, 8);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'PrintBridge',
      submenu: [
        { label: `Version ${app.getVersion()}${DEV ? ' (dev)' : ''}`, enabled: false },
        { type: 'separator' },
        { label: 'Printers near me', accelerator: 'CmdOrCtrl+M', click: () => focusMain() },
        {
          label: now ? `Print at ${now.name}` : 'Print a document',
          accelerator: 'CmdOrCtrl+P',
          enabled: Boolean(now),
          click: () => openPrint(now),
        },
        { type: 'separator' },
        { label: 'Open the log file', click: () => { const file = log.path(); if (file) shell.openPath(file); } },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => quit() },
      ],
    },
    {
      label: 'Machines',
      submenu: [
        ...(known.length
          ? known.map(m => ({
            label: `${now && now.id === m.id ? '● ' : ''}${m.name}${m.reachable === false ? ' (away)' : ''}`,
            tooltip: m.id,
            click: () => { machines.use(m.id); focusMain(); if (win) win.webContents.send('pb:refreshed'); },
          }))
          : [{ label: 'None found yet', enabled: false }]),
        { type: 'separator' },
        { label: 'Look again', accelerator: 'CmdOrCtrl+R', click: () => { if (win) win.webContents.send('pb:rescan'); } },
        { label: 'Enter an address by hand', click: () => focusMain() },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]));
}

function createTray() {
  const image = iconImage();
  if (!image) return;
  try {
    tray = new Tray(image.resize({ width: 16, height: 16 }));
  } catch {
    return;
  }
  const now = machines.current();
  tray.setToolTip(now ? `PrintBridge — ${now.name}` : 'PrintBridge — print a document');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Print a document', enabled: Boolean(machines.current()), click: () => openPrint(machines.current()) },
    { label: 'Printers near me', click: () => focusMain() },
    { type: 'separator' },
    { label: 'Quit', click: () => quit() },
  ]));
  tray.on('double-click', () => focusMain());
}

/* ---------------------------------------------------------------- ipc */

function wireIpc() {
  ipcMain.handle('pb:info', () => ({
    profile: {
      id: profile.id, role: profile.role, productName: profile.productName,
      tagline: profile.tagline, version: app.getVersion(), packaged: app.isPackaged,
    },
    current: machines.current(),
    known: machines.list(),
  }));

  ipcMain.handle('pb:machines:discover', async () => {
    const found = await nearby.browse({ timeoutMs: 2800 });
    const checked = await Promise.all(found.map(async (machine) => {
      const alive = await nearby.confirm(machine.host, machine.port).catch(() => ({ ok: false }));
      if (alive.ok) machines.remember(machine, { name: machine.name || alive.app, tier: alive.tier || machine.tier, version: alive.version || machine.version, lastSeen: new Date().toISOString() });
      return { ...machine, ...alive, reachable: Boolean(alive.ok) };
    }));
    push(`network scan: ${checked.length} machine(s), ${checked.filter(m => m.reachable).length} answering`);
    buildMenu();
    return { current: machines.current(), found: checked, known: machines.list() };
  });

  ipcMain.handle('pb:machines:check', async (event, address) => {
    const parsed = machines.address(address);
    if (!parsed) return { ok: false, reason: 'That is not an address I can use' };
    const alive = await nearby.confirm(parsed.host, parsed.port);
    if (!alive.ok) return { ok: false, reason: alive.reason || 'nothing answered' };
    const saved = machines.remember({ ...parsed, name: address.name || `${parsed.host}`, tier: alive.tier, version: alive.version, source: 'manual' }, { lastSeen: new Date().toISOString() });
    buildMenu();
    return { ok: true, machine: saved, app: alive.app, version: alive.version };
  });

  ipcMain.handle('pb:machines:use', (event, machine) => {
    const saved = machines.use((machine && machine.id) || machine);
    buildMenu();
    return saved ? { ok: true, machine: saved } : { ok: false, error: 'That does not look like an address' };
  });

  ipcMain.handle('pb:machines:forget', (event, id) => {
    const result = machines.forget(String(id || ''));
    buildMenu();
    return { ok: result };
  });

  ipcMain.handle('pb:print', (event, machine, options) => {
    const opened = openPrint(machine, options || {});
    return { ok: Boolean(opened) };
  });

  ipcMain.handle('pb:open-external', (event, url) => shell.openExternal(String(url)));
  ipcMain.handle('pb:logs:get', () => ({ lines: log.tail(400), file: log.path() }));
  ipcMain.handle('pb:logs:clear', () => { log.clear(); return true; });
}

/* ---------------------------------------------------------------- lifecycle */

function quit() {
  quitting = true;
  if (win && !win.isDestroyed()) win.close();
  if (printWin && !printWin.isDestroyed()) printWin.close();
  app.quit();
}

function start(appProfile) {
  profile = appProfile;
  app.setName(profile.productName);

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on('second-instance', () => { focusMain(); });
  app.on('window-all-closed', () => { if (process.platform === 'darwin') app.quit(); });

  app.on('before-quit', async (event) => {
    quitting = true;
    if (appHost) {
      event.preventDefault();
      const closing = appHost;
      appHost = null;
      await closing.close().catch(() => {});
      app.quit();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId(profile.appId);
    machines.init({ userData: app.getPath('userData') });
    wireIpc();
    buildMenu();
    try {
      /* The app's own interface, served from disk over loopback — the same
       * trick the console uses, for the same reason: one origin, no file://
       * module restrictions, and it works with no machine on the network. */
      appHost = await host.start({
        root: path.join(__dirname, '..', 'client-ui'),
        publicDir: path.join(ROOT, 'public'),
        target: () => null,
        log: push,
      });
      createWindow();
      createTray();
      buildMenu();
    } catch (error) {
      push(`startup failed: ${error.message}`);
    }
  });

  return true;
}

module.exports = { start };
