# <img src="docs/printer.svg" width="28" height="28" alt=""> PrintBridge 2.1

A self-hosted print server with two front doors:

- **Guest page — `/`** — scan the QR code, upload a file, pick the printer, see
  exactly how it will print, press *Print*. No app, no account, no PIN, and
  **no admin link anywhere on it**: guests see their own jobs and nothing else.
- **Print code — `#/code`** — every print command gets its own code
  (`PB-7K4Q-2M9D`). The sender follows it from *queued* → *printing* → *printed*.
- **Admin — `/admin`** — the control room, behind a PIN: the printer's connection,
  every job from every device, every print code, defaults, storage and access.
  It lives on the machine running the server; the guest page cannot reach it.

Built for the **HP Neverstop Laser MFP 1200w**, and it works two ways:

| Your printer is… | PrintBridge drives it via | What must stay on |
|---|---|---|
| **USB** (your setup today) | Windows print queue + a silent-print engine | the always-on machine, cabled to the printer |
| **Wi-Fi** (recommended upgrade) | IPP/AirPrint over the network | the always-on machine anywhere on the LAN |

> **About "no desktop needed":** while the printer is on USB, the machine that
> runs PrintBridge must stay plugged into it — that's a cable limit, not a
> software one. Put PrintBridge on any small always-on box (old laptop, mini PC,
> Raspberry Pi) and your daily desktop is free. Flip the printer to Wi-Fi once
> (Admin → Printer → *Move the printer to Wi-Fi*) and the cable goes away.

---

## Quick start (USB, Windows)

```bash
npm install
npm start
```

The console prints everything you need:

```
  Guests scan this to print (no app, no account):   [QR code]
  Guest app    http://192.168.1.6:8088
  Admin app    http://192.168.1.6:8088/admin
  Admin PIN    482913    (first run — change it in Admin → Access)
```

1. Open `/admin`, enter the PIN, go to **Printer** → your HP queue is detected
   automatically (USB port, driver, live depth). Pick it if it isn't selected.
2. If no silent-print engine is found, press **Install** — PrintBridge fetches
   SumatraPDF via `winget`, with a portable-download fallback. Adobe Acrobat or
   Reader is detected and used instead if you already have it.
3. **Print test page.** Then tape the QR card (Admin → **Settings** → *Share this
   printer* → *Print QR card now*) next to the printer. Anyone who scans it can
   print and gets a code for whatever they send; nobody can change anything.

> Setting this up on the machine that owns the printer, step by step — USB
> first, then flipping it to Wi-Fi, then autostart? **`INSTRUCTIONS.md`** is
> written for exactly that and is the fastest path to a first real page.

### Make it truly always-on

PrintBridge only needs *a machine that stays on*:

- **Windows** — Task Scheduler → *At startup* → `node C:\path\to\server.js`
  (tick "Run whether user is logged on or not").
- **Linux / Raspberry Pi** — a systemd unit running `node /opt/printbridge/server.js`.
- **macOS** — a launchd LaunchAgent.

Give that machine a **DHCP reservation** in your router so the QR URL never
changes.

---

## Two apps, one printer

| | Guest (`/`) | Admin (`/admin`) |
|---|---|---|
| Open the page | anyone on the Wi-Fi | PIN required |
| Upload, preview, print | ✅ | ✅ |
| Reprint / delete **own** jobs | ✅ | ✅ |
| See **other people's** jobs | ❌ | ✅ (with the sending device shown) |
| Printer connection, USB queues, engine | ❌ | ✅ |
| Print defaults, paper, retention, upload limit | ❌ | ✅ |
| Storage, diagnostics, server log, cleanup | ❌ | ✅ |
| Pairing QR / printable card | ❌ | ✅ |
| PIN, sessions, gate on/off | ❌ | ✅ |

The separation is enforced **server-side**, not just hidden in the UI: the guest
API cannot reach the admin routes at all, and every guest job is tagged with the
browser that created it. A guest calling another device's job id gets a 404.

---

## Access & the PIN

- A random **6-digit PIN** is generated on first run and printed in the console
  banner. It is stored as a **scrypt hash** in `data/access.json` (never in the
  settings the UI can read, and never sent to a browser).
- **Change it** in Admin → Access. That signs every other device out.
- **Pre-set it** by starting the server with `ADMIN_PIN=…` (used when no
  `access.json` exists yet).
- **Lost it?** Delete `data/access.json` and restart — a fresh PIN is generated
  and printed. (Physical access to the server is the recovery path, by design.)
- **Sessions** last 30 days by default (`sessionDays`), survive restarts, and can
  all be revoked from Admin → Access. A dead session drops the admin UI straight
  back to the PIN screen.
- **Brute force** is throttled: after 5 failures a lockout doubles from 30 s up
  to 15 minutes, per IP, and every failure is logged.
- **Turn the gate off** in Admin → Access for a trusted single-user LAN. Guests
  still cannot reach the admin app in that mode unless they know the URL.

---

## What the guest app does

- Drag-drop or pick files (up to 12 at once), including a camera shortcut.
- **True print preview** — page-by-page render of the actual output with
  thumbnails, zoom, page ranges, copies, paper size, duplex, fit/actual scaling.
- **My prints** — the jobs *this device* sent, with reprint, preview and delete.
- Live status over server-sent events; installable as a PWA.
- **Formats:** PDF, images (JPEG/PNG/HEIC/WEBP/GIF/BMP, multi-page TIFF), plain
  text/CSV/Markdown — plus **Word/Excel/PowerPoint** when LibreOffice is installed
  (detected automatically).

The guest page never loads the admin bundle: `/admin` is a separate document with
its own scripts, and the service worker refuses to cache anything under it.

## How printing works

```
guest ──HTTP──▶ PrintBridge ──▶ print path ──▶ HP Neverstop 1200w
(on your Wi-Fi) (always-on box)      │
                                     ├─ spooler (USB queue, SumatraPDF/Adobe)
                                     ├─ ipp    (network, application/pdf)
                                     ├─ cups   (macOS/Linux driver queue)
                                     └─ outbox (no printer? PDFs saved + listed)
```

The `ipp` path wakes a dozing Wi-Fi printer before each job, reads its name,
state and supply levels back, and falls back to basic job options if the printer
refuses the richer ones. A transient failure never kills a job — see *Printing
nobody has to babysit* above.

Pick a path in Admin → Printer, or leave it on **Automatic**: PrintBridge
resolves the first working route (USB queue → network printer → CUPS → outbox)
and always tells you *why*. A file is never lost — with no printer reachable the
print-ready PDF lands in the Outbox, ready to reprint from the admin queue.

Every upload is normalized server-side to a print-ready PDF and rasterized
page-by-page with pdf.js, so the preview *is* the output. A file that claims to
be a PDF but carries no PDF content is refused rather than sent to the printer.

---

## Configuration

Environment variables (or a `.env`):

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8088` | Web UI port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | Uploads, PDFs, previews, config, jobs, `access.json` |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `ADMIN_PIN` | — | Sets the PIN on first run (when `data/access.json` is absent) |
| `ALLOWED_ORIGINS` | — | Comma-separated origins allowed to call the API from another site, e.g. `https://printbridge.vercel.app`. Unset means same-origin only: no CORS headers are sent |

Everything else lives in Admin → Settings and is persisted to `data/config.json`
(print path, queue names, printer URL, paper, copies, duplex, scaling, retention,
upload limit, preview page limit, keep-alive interval, `adminProtect`,
`sessionDays`).

| Script | Does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run with auto-restart on file changes |
| `npm run check` | Syntax-check every source file |
| `npm run smoke` | End-to-end test (guest pipeline + auth + isolation) |
| `npm run smoke:ipp` | Wi-Fi/IPP end-to-end test against a simulated network printer |
| `npm run build:web` | Build the static frontend bundle for Vercel/Netlify (`PRINTBRIDGE_API_URL=…`) |
| `npm run fake-printer` | Stand up that simulated IPP printer on `127.0.0.1:8631` |
| `npm run icons` | Regenerate PWA icons |

`npm run smoke` exercises the guest pipeline by default. Add the PIN to also test
the admin API, the sign-in, and the guest/admin isolation:

```bash
ADMIN_PIN=123456 npm run smoke
```

---

## API

**Guest — `/api/v1`** (no auth; scoped to the `X-Device-Id` header, or `?device=`
where headers are impossible, e.g. `<img>` and SSE):

```
POST   /jobs                       upload (multipart, batched)
GET    /jobs                       this device's jobs
GET    /jobs/:id                   own job detail
POST   /jobs/:id/print             send / reprint
POST   /jobs/:id/cancel            cancel
GET    /files/:id/pdf|original     print-ready PDF / original upload
GET    /files/:id/preview/:page.png
GET    /files/:id/thumb.png
GET    /files/:id/meta             page count helpers
GET    /printer/status             redacted printer summary
GET    /system/meta|settings       app info + read-only defaults
GET    /system/events?device=…     SSE: own jobs + printer
```

**Admin — `/api/admin`** (session cookie from `POST /login`):

```
POST   /login       PIN → session cookie      POST /logout
GET    /session     who am I                  POST /pin               change PIN
POST   /sessions/revoke       sign out other devices
POST   /sessions/close-all    sign out everywhere
/jobs      every job: list, print, cancel, retry, delete, clear finished
/files     pdf, original, preview, thumbs, outbox listing + downloads
/printer   status, backends, select, locate (mDNS), tools, install helper,
           refresh, test page, queue depth
/system    meta, settings (PATCH), events (SSE with logs), logs, diagnostics,
           storage + cleanup, pairing QR / card PDF / print card
```

---

## Print codes

A **print code** is issued every time somebody presses *Print* — not once per
document. It is short enough to read out loud (`PB-RDY5-7XU5`, no `0`/`O`/`1`/`I`
so it cannot be misheard), unique across the whole server, and its state tracks
that one print command:

| State | Meaning |
|---|---|
| `queued` | accepted, waiting for its turn |
| `waiting` | the printer is asleep or off — still trying |
| `printing` | handed to the printer |
| `printed` | done |
| `failed` / `canceled` | gave up, or the sender stopped it |

The sender sees it on the job screen and on `#/code`, where they can type any old
code back in later. The admin sees the same code in **Admin → Print codes** (and
inline in the queue) with its live state, who sent it and where it went. Printing
the same document again opens a *new* code — the old one keeps its own history.

Codes are scoped to the device that made them: one phone cannot look up another
phone's code, and the guest API returns 404 for it.

### Printing nobody has to babysit

Every job wakes the network printer first, and if the printer is unreachable the
job does **not** fail: it becomes *Waiting for printer*, retries with a growing
backoff (5 s → 2 min) for a configurable window, and fires the moment the printer
answers again. A server restart does not lose those jobs. Set the window in
Admin → Settings → **Network & unattended printing**.

Prove the Wi-Fi path without touching a printer:

```bash
npm run fake-printer                          # a simulated IPP printer
ADMIN_PIN=<pin> npm run smoke:ipp             # end-to-end test: print, fallback, resume
```

### Reaching it from outside your Wi-Fi

There is deliberately **no remote/tunnel feature** in this build. PrintBridge is
meant to serve the network the printer is on: the QR card points at a LAN
address, and nothing is exposed to the internet. If you ever do want it reachable
from outside, put the *whole thing* behind your own VPN or an authenticating
proxy — the app will not help you publish itself, and the guest page (which can
print) should never be on a public URL without one.

---

## Deploying

The normal deployment is the simplest one: the server **is** the site. It serves
the guest page, the API and the admin console from one origin on your LAN, with
nothing to configure, no CORS, and no third party in the loop.

```bash
npm install && npm start        # guests: http://<machine-ip>:8088
```

There is also a static-bundle path (`npm run build:web`) that publishes the
**guest site only** — `public/admin/` is deliberately excluded, so a static host
ever serves the control room — for the case where you put the backend behind real
HTTPS. It cannot work against a plain-`http` LAN backend, because an `https` page
may not call it. Details, the GitHub push and the cookie rules: 
**[docs/deploy.md](docs/deploy.md)**.

> A cloud function cannot reach a printer on your home LAN, and Vercel caps
> request bodies at 4.5 MB — which is why the backend belongs on the machine
> that can see the printer.

## Troubleshooting

- **"Admin sign-in required" everywhere** → the session expired or was revoked;
  sign in again. If the PIN is lost, delete `data/access.json` and restart.
- **No USB queue listed** → the printer needs its HP driver queue once (plug in,
  let Windows install it, print a test page from Notepad). Replug if it shows
  *offline*.
- **Job reaches the outbox instead of the printer** → no usable print path; the
  Printer page names the reason and the Outbox is one click from a reprint.
- **A job fails with "not a valid PDF"** → the file carries a `.pdf` name but no
  PDF content (renamed or damaged in transfer). Re-export or re-send it.
- **Preview pages missing right after upload** → conversion is still running; the
  view retries automatically and shows progress.
- **Wrong margins or page size** → paper size must match the tray (A4 by
  default). The Neverstop 1200w is mono.
- **A deployed frontend cannot reach the API** → its origin is missing from
  `ALLOWED_ORIGINS` on the backend (restart after changing it). Check with
  `curl -i -X OPTIONS <backend>/api/v1/jobs -H "Origin: <frontend>"`.
- **Admin sign-in works on the backend URL but not on the Vercel URL** → the
  backend is plain HTTP, so the `Secure` cross-site cookie is dropped, or the
  browser blocks third-party cookies. Use the HTTPS tunnel URL, or proxy
  `/api/admin` through the frontend (see [docs/deploy.md](docs/deploy.md)).
- **Wi-Fi printers not found** → 2.4 GHz only on this model; guest networks with
  client isolation hide the printer. Add it by IP (just `192.168.1.50` is
  enough — hold **Resume** for 3 s for a report page with the IP).
- **A job sits at "Waiting for printer"** → the printer is asleep, off, out of
  paper, or its IP changed. It retries on its own for the configured window
  (default 30 min) and prints the moment the printer answers. Press **Wake
  printer** in Admin → Printer to nudge it now, and add a DHCP reservation so its
  address never moves.

## Security

Printing is open to anyone on your network **on purpose** — that is the feature.
Everything that *changes* the machine, and everything that shows other people's
documents, sits behind the admin PIN: a scrypt-hashed secret, HttpOnly
SameSite=Strict cookies, per-IP throttling with backoff, and an API split that
keeps the guest surface unable to reach any of it (verified by the smoke test).

On a shared or untrusted network, add a VLAN, an authenticating reverse proxy, or
a VPN such as Tailscale. Keep the gate on wherever more than one person uses the
printer.
