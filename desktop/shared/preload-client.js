'use strict';
/* The customer app's bridge.
 *
 * The machines window is an ordinary web page served from this computer; this
 * is the only thing that reaches back into Electron, and it is a fixed list of
 * named operations. The print window deliberately has no bridge at all: it
 * renders a page served by somebody else's machine, and nothing on this
 * computer should be reachable from there.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printbridgeClient', {
  isClient: true,

  /** What this app is, which machine is chosen, and what it remembers. */
  getInfo: () => ipcRenderer.invoke('pb:info'),

  machines: {
    /** Look for printer machines on this network. */
    discover: () => ipcRenderer.invoke('pb:machines:discover'),
    /** Is a PrintBridge answering at this address? Save it if so. */
    check: (address) => ipcRenderer.invoke('pb:machines:check', address),
    /** Work with this machine from now on. */
    use: (machine) => ipcRenderer.invoke('pb:machines:use', machine),
    /** Forget it. */
    forget: (id) => ipcRenderer.invoke('pb:machines:forget', String(id || '')),
  },

  /** Open the machine's own print page in a window of its own. */
  print: (machine, options) => ipcRenderer.invoke('pb:print', machine || null, options || {}),

  openExternal: (url) => ipcRenderer.invoke('pb:open-external', String(url)),

  logs: {
    get: () => ipcRenderer.invoke('pb:logs:get'),
    clear: () => ipcRenderer.invoke('pb:logs:clear'),
    subscribe(onLine) {
      if (typeof onLine !== 'function') return () => {};
      const handler = (event, line) => onLine(String(line));
      ipcRenderer.on('pb:log', handler);
      return () => ipcRenderer.removeListener('pb:log', handler);
    },
  },

  /** The menu can ask the window to look again or repaint. */
  onRescan(fn) {
    if (typeof fn !== 'function') return () => {};
    const handler = () => fn();
    ipcRenderer.on('pb:rescan', handler);
    return () => ipcRenderer.removeListener('pb:rescan', handler);
  },

  onRefreshed(fn) {
    if (typeof fn !== 'function') return () => {};
    const handler = () => fn();
    ipcRenderer.on('pb:refreshed', handler);
    return () => ipcRenderer.removeListener('pb:refreshed', handler);
  },
});
