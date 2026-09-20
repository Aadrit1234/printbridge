# <img src="docs/printer.svg" width="28" height="28" alt=""> PrintBridge 3.0

Self-hosted print infrastructure for workspaces and shops: **two sites, one
printer, and an app to set it up.**

| Surface | Where | Who it is for |
|---|---|---|
| **Main site** | `/` | the company — about, product, features, pricing, contact — with two buttons: **Print** and **Log in** |
| **Print site** | `/print` | whoever is standing at the printer: enter a printer code, send a document, get a **token number** |
| **Owner site** | `/owner` | the customer: redeem the access code from their licence email, sign in, see their licence |
| **The app** | the desktop app | the machine that owns the printer: the service, the setup, every job, every code, prices, storage, access, and the licence |

The control room is **not a web page**. It lives in the desktop app, which serves
its own interface on `127.0.0.1` and proxies everything else to the print
service. Nothing administrative is reachable over the network — there is no
`/admin` to find, and the app will not start a second copy of the service. The
public sites can also be hosted statically (Vercel, Netlify) while the backend
stays home. See **[docs/deploy.md](docs/deploy.md)**.

All three sites ship a **light and dark theme**: the switch sits in the main
site's nav and the print site's header (and in the console's sidebar). The
choice is one shared preference (`pb.theme`), so picking dark on the main site
means the print site opens dark too.

## How a print happens

```
  code on the sticker            phone / laptop              the print server
  ┌──────────────────┐        ┌────────────────┐        ┌──────────────────────┐
  │  PP-7K4Q-2M9D    │──────▶ │  /print  →     │──────▶ │  queue → print path  │
  └──────────────────┘  type  │  upload        │  HTTP  │  spooler · ipp · cups │
                              │  settings      │        │  · outbox            │
                              │  PRINT         │        └──────────┬───────────┘
                              └────────────────┘                   │
                                       ▲                     ┌─────▼─────┐
                                       └── token number ──── │  printer  │
                                          printed as page 1  └───────────┘
```

1. A **printer code** (`PP-XXXX-XXXX`) is registered in the app's **Printers** and
   stuck on the machine. It names the printer and what it can do.
2. A guest types it on the print site. What happens next depends on the code’s
   **category**:

   | | **Workspace** | **Shop / business** |
   |---|---|---|
   | 1 | code | code |
   | 2 | printer details: name, live/paused, capabilities | **colour or black & white, at the owner’s price per page** |
   | 3 | upload (up to **10** files at once) | printer details |
   | 4 | settings that respect the printer’s capabilities + preview, then **Print** | upload (up to 10) |
   | 5 | token | settings (the colour choice is locked) + preview |
   | 6 | | **payment** — the server prices the real page count |
   | 7 | | token |

3. Every print command gets its own **token**, and that token is **printed as the
   first page** of the document, so nobody picks up the wrong print.
4. The console sees the same token in **Queue** and in **Print codes**:
   *queued → printing → printed*.

## Quick start

```bash
npm install
npm start
```

The console prints everything you need:

```
  Main site    http://192.168.1.6:8088          (about · product · pricing · contact)
  Print site   http://192.168.1.6:8088/print    (what the QR points at)
  (the console is in the desktop app, not on this address)

  Walk-up printer codes (enter these on the print site):
    PP-PTST-4SHP   Corner Print Shop (demo) · shop
    PP-PTST-4WKS   Workspace Copier (demo) · workspace
  Sign-in      admin / 482913-correct-horse    (generated on first run — the app asks for it)
```

Then: the app's **Printer** page to point PrintBridge at the printer, **Printers**
to register a walk-up printer and print its sticker card — and the machine is
open for business. **Setup** on the app's first panel reads all of that back and
tells you what is still missing.

### Or run the desktop app instead

On the laptop that owns the printer, you do not need a terminal at all:

```bash
npm install
npm run desktop        # or build the installer: npm run desktop:build
```

The app **is** the machine: it starts the print service, hosts the console, and
opens on a live checklist of the six things that have to be true before a
stranger can walk up and print. Every panel the console ever had is in there —
Queue, Print codes, Printers, the printer connection, Settings, Access — plus
**Account** for the licence and **Setup** for the machine itself.

It also keeps the service alive: it starts with Windows, hides to the tray when
the window is closed (guests keep printing), holds the laptop awake while jobs
are in flight, streams the service log into the interface, and can run the
project's own end-to-end suites against your printer on demand. It updates itself
from GitHub Releases and says so in the status strip along the bottom.

> Full detail, including packaging, updates and where the data lives:
> **[docs/desktop-app.md](docs/desktop-app.md).**

### Printing nothing can lose

Every upload is converted server-side to a print-ready PDF and rasterized
page-by-page with pdf.js, so the guest preview **is** the output. Then:

- A **Wi-Fi printer that is asleep gets a wake-up call** before every job, and
  its name, state, queue depth and supply levels are read back for the console.
- If the printer is unreachable the job does **not** fail: it becomes *Waiting for
  printer*, retries with a growing backoff (5 s → 2 min) for a configurable
  window (default **30 min**), fires the moment the printer answers again, and
  survives a server restart.
- A printer that refuses the richer IPP job attributes still prints: PrintBridge
  falls back to basic options rather than failing the job.
- With **no printer at all**, the print-ready PDF lands in the **Outbox** and is
  listed in the admin queue, ready to reprint. Nothing is ever lost.

Pick the path in Admin → Printer, or leave it on **Automatic** (Windows spooler →
network/IPP → CUPS → outbox) — it always tells you *why* it chose what it chose.

**Formats:** PDF, images (JPEG/PNG/HEIC/WEBP/GIF/BMP, multi-page TIFF), plain
text/CSV/Markdown — plus Word/Excel/PowerPoint when LibreOffice is present
(detected automatically). A file that claims to be a PDF but carries no PDF
content is refused rather than sent to the printer.

## Accounts, licences and access codes

PrintBridge is multi-tenant: a customer is an **account**, and an account only
ever comes into existence by **redeeming an access code**.

```
  the buyer                   this server                  the buyer
  ┌──────────────┐          ┌──────────────────┐          ┌────────────────┐
  │ the checkout │─────────▶│ order recorded,  │─ email ─▶│  /owner        │
  │ on the site  │  HTTP    │ priced from PLANS│  WS-7K4Q │  code + email  │
  └──────────────┘          │ paid → mint code │  -2M9D   │  + password    │
        ▲                   └──────────────────┘          └────────────────┘
        │ UPI / bank transfer        │                             │
        └────────────────────────────┘                    the app it bought,
          “mark it paid” from the order desk               from GitHub Releases
```

There is deliberately **no sign-up that skips the code**. A code carries the
plan that was paid for (the account inherits it, never the request), it can be
redeemed exactly once, and it can be bound to one address so a code mailed to
somebody only works for them. A code handed to a different address, or reused,
or expired, or revoked, is refused with a reason.

Codes are prefixed by what they buy — **`WS-`** for a workspace, **`SH-`** for a
shop — so the two kinds are never confused in an inbox. The prefix is cosmetic:
a code is accepted with or without it, with or without dashes, in any case, and
codes minted before the prefixes existed (`AC-`) still redeem.

| Plan id | What it is | Price |
|---|---|---|
| `workspace-lifetime` | Workspace, one payment | ₹6,999 |
| `shop-yearly` | Shop, per year | ₹499 |
| `shop-lifetime` | Shop, one payment | ₹11,999 |

### Buying: details → order → code → app

1. **The checkout** (on the pricing page) takes the buyer's name, email, phone
   and billing address, and the way they want to pay. `POST /api/owner/orders`.
   The **price comes from `PLANS`, never from the request** — a browser cannot
   name its own price — and the order gets a number (`PB-2026-0001`) that is the
   handle for everything after.
2. **Payment.** No card details are collected by this site, and none should be:
   the order page shows where to send the money (`PAYMENT_UPI`, or bank
   details). A payment gateway can call the same “paid” step later without
   anything else changing.
3. **The order desk** is where you mark it paid — and that one command mints the
   code for *that* order's plan, binds it to the buyer's address and emails it:

   ```bash
   npm run orders                          # every order, with takings
   npm run orders show PB-2026-0001        # one order in full
   npm run orders paid PB-2026-0001 upi-ref-9931   # → mints + emails the code
   npm run orders resend PB-2026-0001      # send the licence email again
   npm run orders cancel PB-2026-0001 why  # never paid
   npm run orders forget PB-2026-0001      # out of the ledger, code and all
   ```

   Or **the buyer's own page shows the code** the moment the order is paid — it
   polls their order and prints it, so nobody waits on an inbox.
4. **Mail.** With `MAIL_API_KEY` + `MAIL_FROM` (Resend) or `MAIL_WEBHOOK_URL`
   (any relay) the licence email goes out for real. With neither, it is written
   to `data/mail-outbox/<time>-<address>.txt` and the desk prints the path —
   nothing is ever silently dropped, and a code is never only in an error
   message.
5. **Registering** is the code at `/owner` (see below). Once the account exists,
   the page shows what the licence includes and **the app that licence bought** —
   Workspace or Shop — built from the version in `package.json` and the GitHub
   release it was published to. Publish the release and the links go live:

   ```bash
   gh release create v3.1.0 release/*.exe --title "PrintBridge 3.1.0"
   ```

Issuing a code is the **operator key's** job — yours as the vendor, not a
customer's. It comes from `OPERATOR_KEY` in `.env` (16+ characters, no default
and no first-run generation, because a guessable vendor key would be worse than
none). With it unset the desk is closed and no code can be minted — not through
an order either:

```bash
# mint a shop licence by hand, bound to one address, valid for 30 days
curl -X POST http://localhost:8088/api/owner/codes \
  -H "x-operator-key: $OPERATOR_KEY" -H 'Content-Type: application/json' \
  -d '{"plan":"shop-lifetime","email":"buyer@example.com","days":30}'
# → {"code":{"code":"SH-7K4Q-2M9D-X3TB", …}}
```

**What an account can see.** The machine's sign-in opens the whole machine — every
printer, including the seeded demos. An account session opens *only its own*
printers: another account's printer answers 404, not 403, because its existence
is not that customer's business. A patch cannot reassign a printer out of the
account that owns it either. Both are covered by `npm run smoke:accounts`.

## Print codes & printers

A **printer code** (`PP-7K4Q-2M9D`) belongs to a walk-up printer. It is safe to
print on a sticker: it can only be used to send documents to *that* machine, and
the owner can pause the machine at any moment. Codes are written without
`0`/`O`/`1`/`I`, and are resolved whether or not the `PP-` prefix is typed.

A **print token** (`PB-RDY5-7XU5`) is issued every time somebody presses
*Print* — not once per document. Printing the same document again opens a new
token; the old one keeps its own history. Tokens are scoped to the phone that
made them: one phone cannot look up another phone’s code, and the guest API
returns 404 for it.

| Token state | Meaning |
|---|---|
| `queued` | accepted, waiting for its turn |
| `waiting` | the printer is asleep or off — still trying |
| `printing` | handed to the printer |
| `printed` | done |
| `failed` / `canceled` | gave up, or the sender stopped it |

Shop printers are **paid before printed**: the price is recomputed on the server
from the owner’s per-page rates and the document’s real page count, and an unpaid
job is refused with a clear reason. Every page is charged, including the code
page in front.

## Access: the console sign-in

The console — which is the desktop app, and nothing on the network — opens with a
**username and a password**, never a PIN.

- Both are generated on first run and printed in the banner as
  `Sign-in  admin / …`. The password is stored as a **scrypt hash** in
  `data/access.json` — never in the settings the UI can read, never sent to a
  browser.
- **Change them** in the app under Access. That signs every other device out.
- **Pre-set them** with `ADMIN_USER=…` and `ADMIN_PASSWORD=…` when no
  `access.json` exists yet.
- **Lost it?** Delete `data/access.json` and restart — a fresh username and
  password are printed, and shown in the app's Setup panel.
- **An owner account signs in here too**: the email and password behind a
  licence. That is how the shop's laptop opens its console, and how a manager
  gets a session without being told the machine's password.
- **An install from before this keeps working**: the old PIN becomes the
  password of the user `admin`, and the app asks for a real one.
- **Sessions** last 30 days (`sessionDays`), survive restarts, and can all be
  revoked from Admin → Access.
- **Brute force** is throttled: after 5 failures a lockout doubles from 30 s up
  to 15 minutes, per IP, and every failure is logged.
- Guests never touch any of it. The print site is a separate document with its
  own API surface, and its requests carry an `X-Device-Id` rather than a cookie.

## Configuration

Environment variables (or a `.env`):

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8088` | web port |
| `HOST` | `0.0.0.0` | bind address |
| `DATA_DIR` | `./data` | uploads, PDFs, previews, `jobs.json`, `printers.json`, `access.json` |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `ADMIN_USER` | `admin` | the console's username (first run, when `data/access.json` is absent) |
| `ADMIN_PASSWORD` | — | sets the console password on first run. `ADMIN_PIN` is the old name and still honoured |
| `OPERATOR_KEY` | — | the vendor's key for minting access codes and working the order desk. 16+ characters. Unset = the code desk is closed |
| `PUBLIC_URL` | the live site | where the licence email sends a buyer to redeem their code |
| `PAYMENT_UPI` | — | the UPI id the checkout tells buyers to pay. Unset = the checkout asks them to get in touch instead |
| `PAYMENT_PAYEE` | `PrintBridge` | the name shown beside that UPI id |
| `PAYMENT_BANK` | — | "account name, number, IFSC" for buyers who would rather transfer |
| `MAIL_FROM` + `MAIL_API_KEY` | — | send licence emails through Resend. Neither set = they are written to `data/mail-outbox/` instead |
| `MAIL_WEBHOOK_URL` | — | or POST the message as JSON to any relay you run |
| `RELEASES_REPO` | `Aadrit1234/printbridge` | the GitHub repository the installers are published to |
| `RELEASES_BASE` | — | serve those files from your own mirror instead |
| `ALLOWED_ORIGINS` | — | comma-separated origins allowed to call the API from another site. Unset means same-origin only. Once set, a cross-site request from any *other* origin is refused with 403 — not merely hidden from the browser |

Everything else lives in Admin → Settings and is persisted to `data/config.json`
(print path, queue names, printer URL, paper, copies, duplex, scaling, retention,
upload limit, preview page limit, keep-alive interval, retry window,
`adminProtect`, `sessionDays`).

| Script | Does |
|---|---|
| `npm start` | run the server |
| `npm run dev` | run with auto-restart on file changes |
| `npm run check` | syntax-check every source file (server, `src/`, scripts and the front-end) |
| `npm run smoke` | end-to-end guest pipeline + auth + isolation |
| `npm run smoke:walkup` | both guest flows (workspace and shop), codes, checkout, code page |
| `npm run smoke:accounts` | the whole sale: orders, prices, the licence email, codes, signup/login, per-account printer scoping, the download a licence gets |
| `npm run orders` | the order desk: list, show, paid, resend, cancel, forget |
| `npm run smoke:ipp` | Wi-Fi/IPP end-to-end against a simulated network printer |
| `npm run fake-printer` | stand up that simulated printer on `127.0.0.1:8631` |
| `npm run build:web` | build the static bundle for Vercel/Netlify (`PRINTBRIDGE_API_URL=…`) |
| `npm run icons` | regenerate PWA icons |

```bash
npm run smoke                                   # guest surface only
ADMIN_PASSWORD=… npm run smoke                  # + admin API, sign-in, isolation
ADMIN_PASSWORD=… npm run smoke:walkup           # the walk-up flows (needs the sign-in)
OPERATOR_KEY=… ADMIN_PASSWORD=… npm run smoke:accounts  # licences and accounts
```

## API

**Guest — `/api/v1`** (no auth; scoped to the `X-Device-Id` header):

```
GET    /printers/:code             a walk-up printer's public sheet (name, category, prices)
POST   /jobs                       upload (multipart, up to 10 files)
GET    /jobs                       this device's jobs
GET    /jobs/:id                   own job detail
POST   /jobs/:id/print             send / reprint → a new print token
POST   /jobs/:id/pay               settle a shop job (price computed server-side)
GET    /jobs/:id/quote             what a shop job would cost right now
POST   /jobs/:id/retry|cancel      retry / stop trying
DELETE /jobs/:id                   delete (terminal jobs only)
GET    /tickets/:token             the state of one of this device's print commands
GET    /files/:id/pdf|original|preview/:page.png|thumb.png|meta
GET    /printer/status             redacted printer summary
GET    /system/meta|settings       app info + read-only defaults
GET    /system/events?device=…     SSE: own jobs + printer
```

**Admin — `/api/admin`** (session cookie from `POST /login`):

```
POST /login  /logout  /credentials  /sessions/revoke  /sessions/close-all
GET  /session
/printers   the walk-up registry: list, create, get, patch, delete, lookup/:value
/jobs       every job: list, print, cancel, retry, delete, clear finished
/files      pdf, original, preview, thumbs, outbox listing + downloads
/printer    status, backends, select, locate (mDNS), tools, install helper,
            refresh, test page, queue depth, wake
/system     meta, settings (PATCH), events (SSE with logs), logs, diagnostics,
            storage + cleanup, pairing QR / card PDF / print card
```

## Deploying

The normal deployment is the simplest: **the server is the site.** It serves all
three sites and the API from one origin on the network the printer is on — no
CORS, no cross-origin cookies, no third party.

```bash
npm install && npm start        # guests: http://<machine-ip>:8088/print
```

There is also a static-bundle path (`npm run build:web`) that publishes the
**main site and the print site**. The console is not in `public/` at all any
more — it lives in `desktop/renderer/` and ships inside the app — so a static
host could not serve it even by accident. It cannot work against a plain
`http` LAN backend (an `https` page may not call it), so put the backend behind
HTTPS first. Details, the GitHub push and the `ALLOWED_ORIGINS` rules:
**[docs/deploy.md](docs/deploy.md)**.

> A cloud function cannot reach a printer on your home LAN, and Vercel caps
> request bodies at 4.5 MB — which is why the backend belongs on the machine
> that can see the printer.

## Troubleshooting

- **The app asks for a username and password you do not have** → the password is
  a hash in `data/access.json` and cannot be read back. Delete that file and
  restart: a fresh pair is printed in the log, and shown in the app's Setup panel.
- **A guest says “No printer has that code”** → the code belongs to a deleted or
  paused printer, or it was mistyped. Codes are `PP-` plus 8 characters.
- **Job lands in the Outbox** → no usable print path; the app's Printer page
  names the reason.
- **No USB queue listed** → print one page from Notepad so Windows installs the
  driver queue, then press Locate.
- **A shop job refuses to print** → it is unpaid by design. Colour or black &
  white is chosen first, then paid for, then printed.
- **“A job sits at Waiting for printer”** → the printer is asleep, off, out of
  paper, or its IP moved. It retries on its own; **Wake printer** nudges it now.
  Add a DHCP reservation so the address stops moving.
- **Wi-Fi printers not found** → the 1200w is 2.4 GHz only; guest networks with
  client isolation hide the printer. Add it by IP.
- **A deployed site gets 403 (or is blocked by CORS)** → its origin is missing
  from `ALLOWED_ORIGINS` on the backend (restart after changing it). Check with
  `curl -i -X OPTIONS <backend>/api/v1/jobs -H "Origin: <frontend>"`; a 403 body
  names the origin that was refused.
- **The main site’s Log in button 404s on a static host** → the bundle was built
  without `PRINTBRIDGE_ADMIN_URL`; rebuild with it set to the backend origin.
- **A file fails with “not a valid PDF”** → it carries a `.pdf` name but no PDF
  content. Re-export or re-send it.
- **Wrong margins or paper size** → paper must match the tray (A4 by default).

## Security

Printing is open to anyone who has a printer code **on purpose** — that is the
feature. What matters is what a code cannot do: it cannot see other printers'
jobs, other phones' codes, the printer's configuration, or anything in the admin
console. Everything that changes the machine or shows other people's documents
sits behind the console sign-in: a scrypt-hashed password, HttpOnly SameSite=Strict
cookies, per-IP throttling with backoff, and an API split that keeps the guest
surface unable to reach any of it — verified by the smoke tests.

On a shared or untrusted network, add a VLAN, an authenticating reverse proxy, or
a VPN such as Tailscale. Keep the gate on wherever more than one person uses the
printer, and prefer a VPN over a port forward if you publish the sites.
