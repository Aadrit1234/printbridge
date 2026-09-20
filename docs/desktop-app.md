# The desktop app

The machine that owns the printer should not need a terminal, and its control
room should not be a page on the network. This app is both of those things: it
runs the print service, hosts the console on loopback, and keeps itself alive.

**There is no `/admin` any more.** Ask the service for it and it answers 404 with
a note saying where the console went. That is the point of the design — see
[Why it is built this way](#why-it-is-built-this-way).

## Run it

```bash
npm install
npm run desktop          # electron desktop/main.js
```

In development the app attaches to a service you already started (`npm start`) if
one is answering, and otherwise starts its own child process. Both are normal:
there is exactly one service, and two ways to run it.

## Build it

```bash
npm run desktop:pack     # release/win-unpacked/PrintBridge.exe — fast, no installer
npm run desktop:build    # the installers (below)
```

`desktop:build` writes two artifacts, ~101 MB each:

| Artifact | What it is |
|---|---|
| `release/PrintBridge-Setup-<version>.exe` | NSIS installer. Per-user, chooseable location, desktop + Start menu shortcuts. This is the one to hand out. |
| `release/PrintBridge-<version>-portable.exe` | One file, no install — for a machine you would rather not touch. Both are x64 Windows. |

A Mac or Linux build is the same command with a different flag, but the silent
print engine (SumatraPDF) and the spooler integration are Windows-only by design,
so the practical target is Windows on the printer's machine.

### What the packaging config assumes, and why

- **`asar: false`.** The service runs as a *child process* (`server.js` forked as
  Node via `ELECTRON_RUN_AS_NODE`, so the print path never includes Electron).
  A real directory is the boring, reliable way to spawn it, and it keeps the
  native modules (`sharp`, `@napi-rs/canvas`) where the child can load them.
  electron-builder warns about this every build; it is deliberate.
- **`npmRebuild: false`.** Both native dependencies ship N-API binaries, which do
  not need rebuilding against Electron's ABI. Rebuilding them is the usual way a
  packaging job fails for no reason.
- **`extraMetadata.main = desktop/main.js`.** `package.json` still says
  `server.js` so `node .` keeps working; only the packaged app starts Electron.
- **Icon** comes from `public/assets/icon-512.png`; electron-builder derives the
  `.ico` from it. There is no hand-made icon file to keep in sync.
- **Signing is skipped** (`no signing info identified`). A signed build needs a
  Windows code-signing certificate; without one, Windows SmartScreen will warn
  the first time somebody runs the installer. That is a release-pipeline
  decision, not a bug.

## Why it is built this way

```
desktop/main.js      supervisor: starts/attaches the service, window, menus, tray,
                     autostart, keep-awake, notifications of state, updates, self-test
desktop/host.js      the interface host: 127.0.0.1:<ephemeral>, serves the console
                     from disk, proxies /api, /print, /owner, /assets to the service
desktop/preload.js   the bridge: a fixed list of named operations, nothing else
desktop/renderer/    the console itself — the views, the shared UI kit, the store
public/              the guest sites (print, owner, main) and the shared design system
```

The window is pointed at **the host**, never at the print service:

- **One origin.** The console, the API, preview images and the event stream are
  all `http://127.0.0.1:<host port>/…`, so the session cookie is simply sent.
  No CORS, no `ALLOWED_ORIGINS`, no cookie juggling in the renderer — and the
  console's own code needed no rewriting to move into the app.
- **No admin surface on the network.** The service no longer serves the console,
  so there is no URL to find on the LAN. The host binds `127.0.0.1` and dies with
  the app.
- **The guest page still works from inside the app,** because `/print/` and
  `/owner/` are proxied like everything else — and it opens in its own window, so
  the machine's session never shares a page with a stranger's upload form.
- **The interface loads even when the service is down** (its own CSS and modules
  come from disk, not the proxy), which is exactly when you need to be told that.

## Where the data lives

| | Development (`npm run desktop`) | Packaged app |
|---|---|---|
| Jobs, printers, sign-in, outbox | `<repo>/data` | `%APPDATA%/PrintBridge/data` |
| Log | console | `%APPDATA%/PrintBridge/printbridge.log` |

`DATA_DIR` in the environment overrides both — that is how you point the app at a
scratch folder without touching a live install's jobs and printers.

The packaged app cannot write next to its own program files, which is why the
data directory moves. Both are shown in the app: **PrintBridge ▸ Open data
folder**, the machine strip's *Data folder* button, and the Setup panel.

## What the app adds over any web page

| | |
|---|---|
| **Service lifetime** | Starts, restarts and stops the service. `Ctrl+R`, the machine strip, or Setup. |
| **Survives a closed window** | Closing hides to the tray. Guests keep printing — the service is not the window. |
| **Starts with Windows** | *Tools ▸ Start when I sign in to Windows* or the Setup checkbox. No Task Scheduler, no PowerShell. |
| **Stays awake** | Holds a power-save blocker so a sleeping laptop does not stall a job. |
| **The log** | The service's stdout streams into the interface and into `printbridge.log`. Interface errors land in the same file, because a blank panel on a shop counter has to be diagnosable. |
| **The real self-test** | Setup ▸ *Run the end-to-end suites*, or *Tools ▸ Run the real self-test*: it runs `scripts/smoke.cjs` and `scripts/smoke-walkup.cjs` against *this* service, on *this* printer, and prints what they found. The suites sign in with the username and password you entered, kept in memory for the session and never written to disk. |
| **Menu, tray, shortcuts** | Every panel is on `Ctrl+1…8`, the tray has Setup/Queue/restart, and the guest page opens in its own window. |

## Updates

The app updates itself from **GitHub Releases** (`publish` in `package.json`:
`Aadrit1234/printbridge`). electron-builder writes `app-update.yml` into the
package, the app checks a few seconds after launch and then on demand, downloads
in the background, and the machine strip reports `up to date`, `downloading…` or
`restart to update`. *Tools ▸ Restart to install the update* finishes it.

Until a release exists, the app honestly reports `updates: could not check (No
published versions on GitHub)`. Publishing is `npm run desktop:build` plus
uploading the artifacts (and the `.blockmap`, which is what makes a differential
update small) to a GitHub release tagged with the version.

## Troubleshooting

| Symptom | What to do |
|---|---|
| The window says the service did not start | *Server ▸ Restart*, then read the log (Setup ▸ Service log). A port already in use is the usual cause — the app moves up to the next free port, and attaches to an existing service instead of starting a second copy. |
| `the running service is X and this app is Y` | Something else is holding the port — usually `npm start` from a terminal. Restart from inside the app to bring both to the same version. |
| Phones cannot reach the site | Run the firewall command from Setup ▸ *Let phones reach this machine* (it is printed with the right port), and check the phone is on the same network. |
| Printer not listed | Print one page from Notepad so Windows creates the queue, then *Find printers* on the Printer page. |
| Nothing prints, job sits at *waiting* | Sleep, paper, or a changed IP address. The job retries on its own; *Wake printer* forces a check. |
| "Silent print engine missing" | *Install the engine* on the Printer page: SumatraPDF via `winget`, or a portable download as a fallback. |
| Lost the sign-in | Quit the app, delete `access.json` in the data folder, start it again: a fresh username and password print in the log. The hash cannot be recovered, only reset. |
| The interface is blank | The log holds the interface's own errors (`[ui:error] …`). Usually a stale build: `View ▸ Force reload`. |

## Tests

```bash
npm run check            # syntax: node --check for the server, scripts and app shell
                         #         scripts/check-modules.cjs parses every ES module
npm run smoke            # upload → preview → print, plus auth isolation
npm run smoke:walkup     # the workspace and shop guest flows (needs ADMIN_PASSWORD)
npm run smoke:accounts   # access codes → accounts → scoped printers
```

The app's *Run the end-to-end suites* button runs the first two against the
service it is supervising.
