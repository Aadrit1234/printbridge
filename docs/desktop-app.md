# The desktop apps

There are three, and they are the same console wearing three profiles:

| App | Runs the print service? | What it is for | Installer |
|---|---|---|---|
| **PrintBridge Workspace** | **yes** — it *is* the machine | the laptop the printer is plugged into: setup, queue, codes, printers, storage, access, the licence | `release/PrintBridge-Workspace-Setup-<version>.exe` |
| **PrintBridge Shop** | no — it manages somebody else's machine | the owner: everything the machine has, **plus pricing, expenses and revenue**, and its own copy of the books that works with the machine switched off | `release/PrintBridge-Shop-Setup-<version>.exe` |
| **PrintBridge Client** | no — it prints nothing itself | the customer: finds the printer machines on the network and opens the one you use, so the walk-up flow is a thing you double-click | `release/PrintBridge-Client-Setup-<version>.exe` |

One repository, one version number, three products — a shop's app one release
behind the machine it manages is a support call, not a release.

**There is no `/admin` any more.** Ask the service for it and it answers 404 with
a note saying where the console went. That is the point of the design — see
[Why it is built this way](#why-it-is-built-this-way).

## Run them

```bash
npm install
npm run desktop:workspace      # the machine's app   (electron desktop/apps/workspace/main.js)
npm run desktop:shop           # the owner's app
npm run desktop:client         # the customer's app   (npm run desktop is the same as :workspace)
```

In development the machine's app attaches to a service you already started
(`npm start`) if one is answering, and otherwise starts its own child process.
Both are normal: there is exactly one service, and two ways to run it.

## Build them

```bash
npm run desktop:pack           # the machine's app, unpacked: release/win-unpacked/ — fast, no installer
npm run desktop:build          # PrintBridge-Workspace-*-Setup-<version>.exe + -portable.exe
npm run desktop:build:shop     # PrintBridge-Shop-…
npm run desktop:build:client   # PrintBridge-Client-…
```

Each build writes two artifacts:

| Artifact | What it is |
|---|---|
| `release/PrintBridge-<App>-Setup-<version>.exe` | NSIS installer, ~90–106 MB. Per-user, chooseable location, desktop + Start menu shortcuts. This is the one to hand out. |
| `release/PrintBridge-<App>-<version>-portable.exe` | One file, no install — for a machine you would rather not touch. |

All x64 Windows. A Mac or Linux build is the same command with a different flag,
but the silent print engine (SumatraPDF) and the spooler integration are
Windows-only by design, so the practical target is Windows on the printer's
machine.

`electron-builder.<app>.yml` is the config for the two client-side apps (the
machine's lives in `package.json` under `build`). They are worth reading: each
one's `files` list says exactly what that product is, and the customer's app
deliberately ships no server, no console views and no print path — a customer
should never be handed a control surface by accident. Each config lists its own
entry file, and leaving that out is what makes a build fail with *"Application
entry file … does not exist"*.

### What the packaging config assumes, and why

- **`asar: false`.** The machine's app runs the service as a *child process*
  (`server.js` forked as Node via `ELECTRON_RUN_AS_NODE`, so the print path never
  includes Electron). A real directory is the boring, reliable way to spawn it,
  and it keeps the native modules (`sharp`, `@napi-rs/canvas`) where the child
  can load them. electron-builder warns about this every build; it is deliberate.
- **`npmRebuild: false`.** Both native dependencies ship N-API binaries, which do
  not need rebuilding against Electron's ABI. Rebuilding them is the usual way a
  packaging job fails for no reason.
- **`extraMetadata.main = desktop/apps/<app>/main.js`.** `package.json` still says
  `server.js` so `node .` keeps working; only a packaged app starts Electron, and
  which entry it starts is what decides which of the three it is.
- **Icon** comes from `public/assets/icon-512.png`; electron-builder derives the
  `.ico` from it. There is no hand-made icon file to keep in sync.
- **Signing is skipped** (`no signing info identified`). A signed build needs a
  Windows code-signing certificate; without one, Windows SmartScreen will warn
  the first time somebody runs the installer. That is a release-pipeline
  decision, not a bug.

## Why it is built this way

```
desktop/apps/workspace/  profile.js says "this app supervises the machine"   + main.js
desktop/apps/shop/       profile.js says "console apps; pricing, expenses, revenue"
desktop/apps/client/     its own small app (desktop/shared/client-app.js)
desktop/shared/profile.js    the normaliser: panels, home, artifact names
desktop/shared/app.js        the console core — service lifetime, window, menus, tray,
                             autostart, keep-awake, log, updates, self-test, the shop's books
desktop/shared/client-app.js the customer's app: two windows and a tray, nothing else
desktop/shared/host.js       the interface host: 127.0.0.1:<ephemeral>, serves each app's
                             own UI from disk, proxies /api, /print, /owner, /assets
desktop/shared/machines.js   the machines this computer knows, and the one in use
desktop/shared/nearby.js     discovery: mDNS announce/browse, and the probe that
                             asks a host whether it really is a PrintBridge
desktop/shared/shop-store.js the shop's books on this computer, plus which licence
                             last used it (shop app only)
desktop/renderer/            the console itself — views, the shared UI kit, the store
desktop/client-ui/           the customer's window (its own three files)
public/                      the guest sites (print, owner, main) and the design system
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

### The proxy is a client, and must not forward the browser's `Origin`

The host is the *client* of the print service — like `curl` or a native app. The
browser's `Origin` describes the hop inside this computer (the window talking to
the host that served it), so `desktop/shared/host.js` strips it before proxying.

Forwarding it made a machine read a request from its own console as a cross-site
call from `http://127.0.0.1:<port>`. That is harmless while the console sits
beside the service — both loopback, so the machine recognised a local pair — and
a **403 "This origin is not allowed to use this print server"** the moment the
console is pointed at a machine across the network, which is precisely what the
shop's and the customer's apps do. On any install that also serves the website
(therefore has `ALLOWED_ORIGINS` set), the owner's app could not sign in to its
own machine. `scripts/smoke-walkup.cjs` now watches this with a spy upstream:
it asserts that no `Origin` arrives and that `Host` is rewritten to the target.

## The first screen is the machine, not a sign-in

A console app that manages somebody else's machine has no server until one is
chosen, so the session call has nothing to answer it. A fresh install of the
shop's or the customer's app therefore opens — and must open — on the **machine
picker**, then reload pointed at the machine you chose and sign in there. Getting
this wrong showed a sign-in form saying *"the print server is not responding. Is
it running?"*, which was both false and unanswerable.

Two small things make the picker work, and both were once broken:

- **A machine found by mDNS has an id.** The id *is* its address, and it is what
  each row's button carries; without it every "Use this" sent the string
  `"undefined"` and did nothing, silently.
- **The probe reads the guest meta.** That is the only meta a stranger's app may
  read, and it names the app as `appName`, not `app`. Insisting on the
  admin-shaped keys made every machine on every network invisible, and reported a
  perfectly good PrintBridge as *"something else answers at that address"*.

The sign-in screen also names the machine it is signing in to, with **Choose a
different machine** — otherwise the only way out of a console pointed at the
wrong machine is deleting `machines.json` by hand, because the menus that reach
the picker sit behind being signed in.

## The shop's books work with the machine switched off

Local first means exactly this: the panels read and write the copy on this
computer, and the machine's copy is the meeting point, not the master. Every
record carries `updatedAt`, a delete travels as a tombstone, and the two sides
merge newest-wins (`src/services/shop.js` explains the protocol) — so a counter
that loses its network does not lose the day's expenses, and a second laptop
cannot resurrect a mistake.

Working offline needs to know *whose* books are on this laptop, and the only
thing that can answer that is the machine. So the app remembers the licence that
last used it, per machine, in `<userData>/shop/last-account.json`. Without that,
a shop whose machine was switched off opened on the machine picker and could not
reach its own expenses — which would make "local first" mean "local, when
online". With it, the app opens on the books, says **Working offline**, keeps
every entry, and syncs it the moment the machine is back.

## Where the data lives

Each app keeps its own folder — one laptop can have all three installed, and they
are different products:

| | Development | Packaged app |
|---|---|---|
| Workspace | `<repo>/data` | `%APPDATA%/PrintBridge Workspace/data` |
| Shop | `<repo>/shop` + `<repo>/data` | `%APPDATA%/PrintBridge Shop/` — `shop/<accountId>.json`, `machines.json`, `last-account.json` |
| Client | — | `%APPDATA%/PrintBridge Client/` — `machines.json` |
| Log | console | `<that folder>/printbridge.log` |

`DATA_DIR` in the environment overrides the machine app's data directory — that
is how you point the app at a scratch folder without touching a live install's
jobs and printers.

The name alone is not enough to get this: in a **packaged** build Electron has
already worked out `userData` from `package.json`'s `name` by the time the app
starts, so all three landed in one folder, `%APPDATA%/printbridge`, sharing one
machines list, one console sign-in and one set of books. Each app now sets that
path explicitly from its profile.

Both folders are shown in the app: **PrintBridge ▸ Open data folder**, the
machine strip's *Data folder* button, and the Setup panel.

## What the apps add over any web page

| | |
|---|---|
| **Service lifetime** | The machine's app starts, restarts and stops the service (`Ctrl+R`, the machine strip, or Setup). The shop's and the customer's apps read somebody else's machine and deliberately offer no restart. |
| **Survives a closed window** | Closing hides to the tray. Guests keep printing — the service is not the window. |
| **Starts with Windows** | *Tools ▸ Start when I sign in to Windows* or the Setup checkbox. No Task Scheduler, no PowerShell. |
| **Stays awake** | Holds a power-save blocker so a sleeping laptop does not stall a job. |
| **The log** | The service's stdout streams into the interface and into `printbridge.log`. Interface errors land in the same file, because a blank panel on a shop counter has to be diagnosable. |
| **The real self-test** | Setup ▸ *Run the end-to-end suites*, or *Tools ▸ Run the real self-test*: it runs `scripts/smoke.cjs` and `scripts/smoke-walkup.cjs` against *this* service, on *this* printer, and prints what they found. The suites sign in with the username and password you entered, kept in memory for the session and never written to disk. |
| **Menu, tray, shortcuts** | Every panel is on `Ctrl+1…8`, the tray has Setup/Queue/restart, and the guest page opens in its own window. |

## Updates

Every app updates itself from **GitHub Releases** (`publish` in `package.json`:
`Aadrit1234/printbridge`). electron-builder writes `app-update.yml` into the
package, the app checks a few seconds after launch and then on demand, downloads
in the background, and the machine strip reports `up to date`, `downloading…` or
`restart to update`. *Tools ▸ Restart to install the update* finishes it.

An unpacked `desktop:pack` build has no `app-update.yml`, so it honestly reports
`updates: could not check (ENOENT … app-update.yml)`. That is expected in a
`--dir` build and never in an installer.

Publishing is the three `desktop:build*` commands plus uploading the artifacts
(and the `.blockmap`, which is what makes a differential update small) to a
GitHub release tagged with the version. The machine's app — and, if you have set
`RELEASES_REPO`, the owner site's download links — read that release by tag.

## Troubleshooting

| Symptom | What to do |
|---|---|
| The window says the service did not start | *Server ▸ Restart*, then read the log (Setup ▸ Service log). A port already in use is the usual cause — the machine's app moves up to the next free port, and attaches to an existing service instead of starting a second copy. |
| `the running service is X and this app is Y` | Something else is holding the port — usually `npm start` from a terminal. Restart from inside the app to bring both to the same version. |
| **"This origin is not allowed to use this print server"** | The console asked the machine from a page it did not serve. Make sure nothing reintroduces a browser `Origin` on the proxy hop in `desktop/shared/host.js`; `npm run smoke:walkup` fails if it does. |
| **The shop's app opens on the machine picker every launch** | No machine is chosen or the chosen one is away. Pick one, or check the machine is running — the app only signs in to a machine it can reach. |
| **"Working offline" in the shop's app** | Expected when the machine is off: the books are the copy on this computer. Enter what you need; it syncs when the machine answers. If it never syncs, the machine's copy has an older `updatedAt` per row — newest wins. |
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
npm run smoke:walkup     # the workspace and shop guest flows, CORS, discovery, the proxy
                         #         (needs ADMIN_PASSWORD)
npm run smoke:accounts   # access codes → accounts → scoped printers (needs OPERATOR_KEY)
npm run smoke:shop       # pricing, expenses, reports and the CSV
```

The app's *Run the end-to-end suites* button runs the first two against the
service it is supervising.

The app windows themselves are not driven by the browser preview — the preview is
a plain browser with no Electron bridge, so it sees the machine app's profile and
none of the shop's panels. Electron is Chromium, though, so with
`--remote-debugging-port` it will describe its own DOM:

```bash
npm run desktop:shop -- --remote-debugging-port=9223     # in one terminal
node scripts/devtools-eval.cjs "document.body.innerText" 9223
```

That is how the three apps were launch-tested: which first screen each opens on,
what a panel rendered, and whether the machine strip agrees with the service.
