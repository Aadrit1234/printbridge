'use strict';
/* The desktop bridge.
 *
 * The setup console is an ordinary web page served by the local server; this is
 * the only thing that reaches back into Electron, and it is a fixed list of
 * named operations. No `ipcRenderer`, no `require`, no filesystem in the page.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printbridgeDesktop', {
  isDesktop: true,

  /** Port, data directory, packaged-or-not, version. */
  getInfo: () => ipcRenderer.invoke('pb:info'),

  /** Stop and start the print service this app owns, then wait for it. */
  restartServer: () => ipcRenderer.invoke('pb:server:restart'),

  /** Show the folder holding jobs, printers and the hashed sign-in. */
  openDataFolder: () => ipcRenderer.invoke('pb:open-data'),

  /** Hand a URL to the real browser (never used for our own pages). */
  openExternal: (url) => ipcRenderer.invoke('pb:open-external', String(url)),

  /** Remember the password for this session only, so the self-test can sign in. */
  rememberPassword: (password) => ipcRenderer.invoke('pb:password', String(password || '')),

  /** Run the project's end-to-end suites against this service and report back. */
  runSelfTest: () => ipcRenderer.invoke('pb:selftest'),

  logs: {
    get: () => ipcRenderer.invoke('pb:logs:get'),
    clear: () => ipcRenderer.invoke('pb:logs:clear'),
    subscribe(onLine) {
      if (typeof onLine !== 'function') return () => {};
      const handler = (event, line) => onLine(String(line));
      ipcRenderer.on('pb:log', handler);
      return () => ipcRenderer.removeListener('pb:log', handler);
    },
    onSelfTestRequested(onRequest) {
      if (typeof onRequest !== 'function') return () => {};
      const handler = () => onRequest();
      ipcRenderer.on('pb:run-selftest', handler);
      return () => ipcRenderer.removeListener('pb:run-selftest', handler);
    },
  },

  /** Menu and tray can send the window to a panel. */
  onNavigate(onHash) {
    if (typeof onHash !== 'function') return () => {};
    const handler = (event, hash) => onHash(String(hash || ''));
    ipcRenderer.on('pb:navigate', handler);
    return () => ipcRenderer.removeListener('pb:navigate', handler);
  },

  /** Updates: check, install, and follow the state as it changes. */
  updates: {
    status: () => ipcRenderer.invoke('pb:updates:status'),
    check: () => ipcRenderer.invoke('pb:updates:check'),
    install: () => ipcRenderer.invoke('pb:updates:install'),
    subscribe(onState) {
      if (typeof onState !== 'function') return () => {};
      const handler = (event, state) => onState(state || { kind: 'off' });
      ipcRenderer.on('pb:update', handler);
      return () => ipcRenderer.removeListener('pb:update', handler);
    },
  },

  autostart: {
    get: () => ipcRenderer.invoke('pb:autostart:get'),
    set: (enabled) => ipcRenderer.invoke('pb:autostart:set', Boolean(enabled)),
  },

  keepAwake: {
    get: () => ipcRenderer.invoke('pb:keepawake:get'),
    set: (enabled) => ipcRenderer.invoke('pb:keepawake:set', Boolean(enabled)),
  },

  /* ---------------- the shop's app: which machine, and its own books ------- */

  machines: {
    list: () => ipcRenderer.invoke('pb:machines:list'),
    discover: () => ipcRenderer.invoke('pb:machines:discover'),
    check: (address) => ipcRenderer.invoke('pb:machines:check', address),
    use: (machine) => ipcRenderer.invoke('pb:machines:use', machine),
    forget: (id) => ipcRenderer.invoke('pb:machines:forget', String(id || '')),
  },

  /* The local copy of the shop's document. Local first: the panel reads and
   * writes this, and the sync to the machine happens when there is one. */
  shop: {
    load: (accountId) => ipcRenderer.invoke('pb:shop:load', String(accountId || '')),
    save: (accountId, state) => ipcRenderer.invoke('pb:shop:save', String(accountId || ''), state || {}),
  },
});
