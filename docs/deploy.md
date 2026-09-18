# Deploy: three sites, one printer

PrintBridge is three sites and one server. Understanding which site lives where
is the whole of this document.

| Site | Path | Who it is for | Lives where |
|---|---|---|---|
| **Main site** | `/` | the public — company, product, features, pricing, contact | the print server, *and optionally* a static host (Vercel) |
| **Print site** | `/print` | whoever is standing at the printer | the print server, *and optionally* the same static host |
| **Admin site** | `/admin` | the owner (PIN) | **only** the print server |
| **API** | `/api/v1`, `/api/admin` | the two sites above | only the print server |

And **one server**, on the machine next to the printer. That is not a
limitation to work around — it is the design:

> **Why the backend cannot be a cloud function:** it has to talk to a printer on
> your home network (a LAN-only device), it writes uploads, previews and
> print-ready PDFs to disk, and it keeps in-memory queue and ticket state.
> Vercel Functions have no persistent disk, no route to your LAN, and cap request
> bodies at 4.5 MB. So the backend lives on the machine that can see the printer.

The **admin console never goes into a static bundle**. It is the surface that
changes the machine and shows other people's documents, it needs a same-origin
session cookie to be trustworthy, and there is no reason for it to be on a public
host. `npm run build:web` skips `public/admin/` on purpose.

---

## 1. The normal deployment: the server *is* the site

```bash
npm install
npm start          # prints the QR code, the LAN address and the ADMIN PIN
```

Guests on the same Wi-Fi use `http://<machine-ip>:8088/print`. Nothing else is
required: no CORS, no cookies across origins, no third party in the loop.

1. **DHCP reservation** for the machine in your router, so every printed sticker
   keeps working.
2. **Firewall** (once, elevated):
   ```powershell
   New-NetFirewallRule -DisplayName "PrintBridge" -Direction Inbound -Action Allow `
     -Protocol TCP -LocalPort 8088 -Profile Private
   ```
   Linux: `sudo ufw allow from 192.168.1.0/24 to any port 8088 proto tcp`
3. **Start at boot** — Task Scheduler on Windows, a systemd unit on Linux
   (`Restart=always`), `--restart unless-stopped` on Docker. The copy-paste blocks
   are in [../INSTRUCTIONS.md](../INSTRUCTIONS.md#6-make-it-survive-a-reboot).
4. **Set up the printer and hand out codes** — see
   [../INSTRUCTIONS.md](../INSTRUCTIONS.md): Admin → Printer for the connection,
   Admin → Printers to register a walk-up printer and print its sticker.

Configuration that must survive restarts belongs in `./.env` (loaded at startup;
a real environment variable wins):

```bash
PORT=8088
DATA_DIR=C:\printbridge\data
LOG_LEVEL=info
ADMIN_PIN=              # optional: set it instead of the generated one on first run
ALLOWED_ORIGINS=        # only for the static deployment in §3
```

---

## 2. Push to GitHub

```bash
git add -A
git commit -m "…"
gh repo create printbridge --public --source=. --remote=origin --push
```

`.gitignore` already excludes `data/` (jobs, uploads, the PIN hash), `node_modules/`,
`dist*/`, `.env` and `server.log`. **Check what is staged before you push** —
`git status --short` and `git diff --cached --stat` are enough.

---

## 3. Optional: main site + print site on Vercel

Worth doing when the backend is reachable over **HTTPS** from where your visitors
are. An `https` page may not call a plain-`http` LAN address, so with a LAN-only
backend the deployed sites load and then report that the server is unreachable.
Put the backend behind Tailscale (or a VPN/authenticating proxy) first.

```bash
# Build the public bundle: main site + print site, admin excluded.
PRINTBRIDGE_API_URL=https://<https-reachable-backend> \
PRINTBRIDGE_ADMIN_URL=https://<https-reachable-backend> \
  npm run build:web

# -> dist/  (main site at /, print site at /print/, no /admin)
cd dist && vercel --prod
```

Then on the backend, list that origin, or the browser refuses every call:

```bash
ALLOWED_ORIGINS=https://your-project.vercel.app npm start
```

What the build writes into `dist/config.js` (and why):

| Key | Meaning |
|---|---|
| `apiBase` | the backend origin — every API call and file URL is built from it |
| `adminBase` | where the control room lives, so the main site's **Admin** button points at the real console instead of a 404 |

* **Each preview deployment is a new origin.** Add it to `ALLOWED_ORIGINS`, or
  switch previews off for the project. Once an allowlist is set, a cross-site
  request from any origin *not* on it is refused with **403** — otherwise a page
  on another site could still fire requests at your printer (a form post to
  `/api/v1/jobs` prints a document) even though CORS hides the reply. Requests
  with no `Origin` header — curl, native apps, health checks — still work, so an
  allowlist never breaks your own scripts.
* **Guest requests carry no cookies** — the print site identifies a phone with an
  `X-Device-Id` header, so cross-origin printing works everywhere, including
  Safari and Firefox.
* **The admin console is not in the bundle**, so there is nothing to get wrong
  there: it stays on the server's own address.

---

## 4. Verify a deployment

```bash
# 1. the server answers on this machine
curl -s http://localhost:8088/api/v1/system/meta

# 2. the sites are the current build
curl -s http://localhost:8088/config.js
curl -s http://localhost:8088/deployment.json

# 3. a printer code resolves (use a real one from Admin → Printers)
curl -s http://localhost:8088/api/v1/printers/PP-XXXX-XXXX

# 4. the flows, without a printer
npm run check && npm run smoke && npm run smoke:ipp
ADMIN_PIN=<pin> npm run smoke:walkup
```

`smoke:walkup` is the one that matters after a change to the guest flow: it
registers a temporary workspace printer and a temporary shop printer, walks both
end to end, and checks the things that break quietly — that a shop refuses an
unpaid job, that the code page is really merged in front of the document, and
that a print code is scoped to the phone it was given to.

If you deployed the static bundle, confirm it names the right backend:

```bash
curl -s https://your-project.vercel.app/config.js
```

---

## 5. Updating

```bash
git pull
npm install                  # only if package.json changed
# Windows: Stop-ScheduledTask -TaskName PrintBridge; Start-ScheduledTask -TaskName PrintBridge
# Linux:   sudo systemctl restart printbridge
# Vercel:  re-run npm run build:web && vercel --prod
```

The print site is installable (a PWA) and the service worker is update-safe:
navigations are network-first, old caches are purged, and an open tab reloads
once so nobody keeps running old markup against new scripts.

---

## 6. Where "print from anywhere" went

Earlier builds shipped an in-product remote-access feature (Tailscale detection,
a remote-address field, a “QR card for the road”). The code, routes, config keys
and UI for it have been **removed**. Publishing this server is now a deployment
decision, not a product feature — the guest surface stays a single-purpose
consumer flow (code → upload → settings → token) with nothing in it about
networks, tunnels or addresses.

If you do publish it, remember what you are publishing: **anyone who has a
printer code can send a job to that printer.** Keep the admin PIN on, keep codes
off public pages, and prefer a VPN or an authenticating proxy over a port
forward.
