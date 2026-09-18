# Deploy: GitHub, the server on its own machine, and an optional static guest site

PrintBridge is designed to be boring to deploy: **the server is the site**. It
serves the guest page, the API and the admin console from one origin on the
network the printer is on. Everything else in this document is optional.

| Piece | Runs where | Serves |
|---|---|---|
| **PrintBridge server** | the machine next to the printer (always on) | guest page `/`, API `/api/v1`, admin `/admin` |
| **Static guest bundle** *(optional)* | any static host, e.g. Vercel | `public/` minus `public/admin/` — the guest page only |
| **GitHub** | — | the source of both |

> **Why the backend cannot be a cloud function:** it has to talk to a printer on
> your home network (a LAN-only device), it writes uploads and previews to disk,
> and it keeps in-memory queue and ticket state. Vercel Functions have no
> persistent disk, no route to your LAN, and cap request bodies at 4.5 MB. So the
> backend lives on the machine that can see the printer.

---

## 1. Push to GitHub

```bash
git init -b main            # already done if you cloned this repo
git add -A
git commit -m "PrintBridge"
gh repo create printbridge --public --source=. --remote=origin --push
```

`.gitignore` already excludes `data/` (jobs, uploads, the PIN hash), `node_modules/`,
`dist*/`, `.env` and `server.log`. **Check that nothing private is staged before
you push** — `git status --short` and `git diff --cached --stat` are enough.

```bash
gh repo view --web
```

---

## 2. Run the server on the always-on machine

```bash
npm install
npm start                   # prints the QR code, the LAN address and the admin PIN
```

1. **Give the machine a DHCP reservation** in your router, so the address on the
   QR card never changes.
2. **Let other devices in** (once, elevated):
   ```powershell
   New-NetFirewallRule -DisplayName "PrintBridge" -Direction Inbound -Action Allow `
     -Protocol TCP -LocalPort 8088 -Profile Private
   ```
   Linux: `sudo ufw allow from 192.168.1.0/24 to any port 8088 proto tcp`
3. **Start it at boot** so printing works without anyone logging in:

   **Windows** (elevated PowerShell) —
   ```powershell
   $action  = New-ScheduledTaskAction -Execute (Get-Command node).Source `
                -Argument "server.js" -WorkingDirectory "C:\printbridge"
   $trigger = New-ScheduledTaskTrigger -AtStartup
   Register-ScheduledTask -TaskName "PrintBridge" -Action $action -Trigger $trigger `
     -RunLevel Highest -User "SYSTEM"
   ```

   **Linux (systemd)** — `/etc/systemd/system/printbridge.service`
   ```ini
   [Unit]
   Description=PrintBridge
   After=network-online.target
   [Service]
   WorkingDirectory=/opt/printbridge
   ExecStart=/usr/bin/node server.js
   Restart=always
   User=printbridge
   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   sudo systemctl enable --now printbridge
   ```

   **Docker**
   ```bash
   docker run -d --name printbridge --restart unless-stopped \
     -p 8088:8088 -v printbridge-data:/app/data --env-file .env printbridge
   ```

4. **Set up the printer** in Admin → **Printer** (USB queue, or Wi-Fi over IPP),
   then print the QR card from Admin → **Settings** and tape it next to the
   printer. Full walkthrough: **[../INSTRUCTIONS.md](../INSTRUCTIONS.md)**.

Configuration that needs to survive restarts belongs in `./.env` (loaded at
startup, real environment wins):

```bash
PORT=8088
DATA_DIR=C:\printbridge\data
LOG_LEVEL=info
ADMIN_PIN=            # optional: set it instead of the generated one on first run
ALLOWED_ORIGINS=      # only needed for the optional static frontend, below
```

---

## 3. Optional: a static guest site on Vercel

Only useful if the backend is reachable over **HTTPS** from wherever the visitor
is. A page served over `https` may not call a plain-`http` LAN address, so with a
LAN-only backend this bundle will load and then report that the server is
unreachable. Skip this section unless you are putting the backend behind HTTPS.

```bash
PRINTBRIDGE_API_URL=https://<https-reachable-backend> npm run build:web
# → dist/ (guest site only; public/admin/ is never copied)
cd dist && vercel --prod
```

Then on the backend, allow that origin, or the browser blocks every call:

```bash
ALLOWED_ORIGINS=https://your-project.vercel.app node server.js
```

* **The admin console is not in the bundle.** `npm run build:web` skips
  `public/admin/` on purpose, so a static host cannot serve `/admin` at all. The
  console is only on the print server's own address.
* **Each preview deployment is a new origin.** Add it to `ALLOWED_ORIGINS`, or
  turn preview deployments off for the project.
* **Cookies:** the guest API authenticates with an `X-Device-Id` header, not a
  cookie, so cross-origin guest printing is unaffected. The *admin* console uses a
  session cookie and is meant to be used same-origin on the server's address; if
  you ever serve it cross-origin, the backend sets `SameSite=None; Secure` for
  allowlisted origins and you should still expect Safari/Firefox third-party
  cookie blocking.

---

## 4. Verify a deployment

```bash
# 1. the server answers on this machine
curl -s http://localhost:8088/api/v1/system/meta

# 2. the guest page is the current build (check the version/deployment fingerprint)
curl -s http://localhost:8088/config.js

# 3. guests can actually print: upload something from a phone on the same Wi-Fi,
#    press Print, and confirm the code appears in Admin → Print codes as printed

# 4. the whole app, without a printer (uses a simulated IPP printer)
npm run check && npm run smoke && npm run smoke:ipp
```

If you deployed the optional static bundle, also confirm it names the right
backend: `curl -s https://your-project.vercel.app/config.js`.

---

## 5. Updating

```bash
git pull
npm install                  # only if package.json changed
# Windows:  Stop-ScheduledTask -TaskName PrintBridge; Start-ScheduledTask -TaskName PrintBridge
# Linux:    sudo systemctl restart printbridge
```

The guest page is a PWA; the service worker is update-safe (navigations are
network-first, old caches are purged, open tabs reload once). A redeployed static
bundle needs no client action beyond a refresh.

---

## 6. Where "print from anywhere" went

Earlier builds shipped a remote-access feature (Tailscale detection, a remote
address field, a "QR card for the road"), and the code, routes, config keys and
UI for it have been **removed**. The reasons, in order:

1. It was the only part of the product that encouraged putting a page that can
   *print* on the public internet.
2. The guest page is now a single-purpose consumer surface — upload, printer
   picker, preview, print code — and a remote address field does not belong on it.
3. Everything it did, a VPN does better and without this app's help.

If you ever need it: put the server behind Tailscale (or any VPN/authenticating
proxy), not behind a port-forward, and do not publish the guest page.
