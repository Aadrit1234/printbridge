# Print anywhere: Wi-Fi printer, always-on server, unattended printing

This is the full path from "the printer is on a USB cable" to "I press Print on
my phone in another city and paper comes out at home". Three parts, in order:

1. **Put the printer on Wi-Fi** — the cable goes away.
2. **Make the server always-on** — it runs itself, at boot, no login.
3. **Reach it from anywhere** — a private VPN (Tailscale), free, nothing exposed.

Then: **how a job that is sent from far away actually prints with nobody there.**

Everything here is for the **HP Neverstop Laser MFP 1200w**; the PrintBridge
steps (2–4) are the same for any IPP/AirPrint printer.

---

## 1. Move the printer to Wi-Fi (once, ~5 minutes)

The `w` in *1200w* means wireless. The printer has no touchscreen, so setup is
done from a phone or PC.

**a. Connect it to your Wi-Fi**

- **HP Smart app (easiest).** Install HP Smart (Windows, macOS, iOS, Android),
  choose *Add printer* → *Set up a new printer*, and let it run the wireless
  setup. It joins your **2.4 GHz** network — this model cannot see 5 GHz.
- **WPS (no app).** Hold the printer's **Wireless** button until its blue light
  blinks, then press **WPS** on your router within two minutes.
- **Printer's own report.** Press and hold **Resume/Wireless** for 3 seconds to
  print a configuration page; it lists the IP the printer received (looks like
  `192.168.1.50`).

**b. Give it a fixed address**

In your router's admin page, add a **DHCP reservation** for the printer's MAC
address. Without this the printer's IP can change, and PrintBridge would be
pointing at nothing. (If the reservation is impossible, PrintBridge's mDNS
discovery usually still finds it by name.)

**c. Check it answers on the network**

Open `http://<printer-ip>` in a browser — you should get the HP embedded web
server. If not, you are probably on a 5 GHz-only SSID or a guest network with
client isolation.

**d. Point PrintBridge at it**

Admin → **Printer** → **Network** tab (discovery runs by itself; or paste just
the IP — `192.168.1.50` is a valid address, no `ipp://` needed) → **Save** → then
**Print test page**.

**e. Stop it falling asleep on Wi-Fi**

In the same Network tab set **Keep-alive** to `10` (minutes). Idle Wi-Fi
printers drop off the network to save power; this keeps the link warm, and every
job also sends its own wake-up call first.

**f. Unplug the USB cable.** PrintBridge no longer needs it. If the always-on
machine used the Windows USB queue, switch the print path to **Automatic** (it
resolves to the network printer) or pin **Network printer (IPP / AirPrint)**.

---

## 2. Make the server always-on

PrintBridge only needs *a machine that stays switched on*. An old laptop, a mini
PC or a Raspberry Pi is ideal. Give **that machine** a DHCP reservation too, so
its address never moves.

Copy the project somewhere permanent first (e.g. `C:\printbridge`, `/opt/printbridge`)
and run `npm install` there once.

### Windows — Task Scheduler

```powershell
# Run once in an elevated PowerShell, from the project folder.
$exe  = (Get-Command node).Source
$dir  = (Get-Location).Path
$action  = New-ScheduledTaskAction -Execute $exe -Argument "server.js" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "PrintBridge" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -User "SYSTEM"
Start-ScheduledTask -TaskName "PrintBridge"
```

`-User "SYSTEM"` means it runs **whether or not anyone is logged in**. Keep
SumatraPDF installed for the machine (the admin printer page can install it) so
USB queues still work.

### Linux / Raspberry Pi — systemd

```ini
# /etc/systemd/system/printbridge.service
[Unit]
Description=PrintBridge print server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=printbridge
WorkingDirectory=/opt/printbridge
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now printbridge
systemctl status printbridge
```

### macOS — launchd

```bash
cat > ~/Library/LaunchAgents/com.printbridge.server.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.printbridge.server</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/node</string><string>server.js</string></array>
  <key>WorkingDirectory</key><string>/Users/YOU/printbridge</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
PLIST
launchctl load ~/Library/LaunchAgents/com.printbridge.server.plist
```

### Docker

```yaml
# docker-compose.yml, in the project folder
services:
  printbridge:
    image: node:20
    working_dir: /app
    command: sh -c "npm ci --omit=dev && node server.js"
    restart: unless-stopped
    network_mode: host          # so mDNS discovery and IPP work
    volumes:
      - ./:/app
      - ./data:/app/data
    environment:
      DATA_DIR: /app/data
      ADMIN_PIN: choose-a-pin
```

`docker compose up -d`. A container can print over IPP (network) but **cannot**
reach a USB queue on the host, so use Wi-Fi mode if you containerise. Note the
`host` network mode: without it, mDNS discovery and some printers' IPP replies do
not reach the container.

---

## 3. Reach it from anywhere — Tailscale (free, nothing exposed)

Do **not** forward a port on your router: that publishes an unauthenticated
printer to the whole internet. Use a private mesh instead. Tailscale's personal
plan is free (up to 3 users / 100 devices) and your devices see each other as if
they were on the same LAN.

**a. On the always-on machine**

```bash
# Linux / Raspberry Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh

# Windows / macOS: install the app from https://tailscale.com/download and sign in
```

**b. On the phone/laptop you print from**

Install the Tailscale app, sign in with the **same account**. That is the whole
point of the mesh — no other configuration.

**c. Find the address**

```bash
tailscale status          # your machine's name, e.g. printbridge.tailnet-1234.ts.net
tailscale ip -4           # or the 100.x.y.z address
```

The URL is `http://<name>:8088` — it works at home and on mobile data. Open it in
the phone's browser to confirm you get the guest print page.

**d. Get a proper HTTPS address (optional but nice)**

```bash
sudo tailscale serve --bg 8088
tailscale serve status     # prints the https:// URL
```

Tailscale issues a real certificate for that name, so the browser shows no
warning and PrintBridge's admin cookie is automatically marked `Secure`.

**e. Record it in PrintBridge**

Admin → **Settings** → **Print from anywhere**:

- the card detects Tailscale on its own and shows the address it will use;
- paste a different address (a tunnel hostname, a mesh name) in the field and
  **Save** if you prefer;
- **Test from here** makes the server call that URL through the real route and
  tells you whether it answered;
- **Download QR card for the road** gives you a printable card with that URL, so
  your own devices can scan instead of typing.

Printers, iPads, phones and laptops all work; guests at home keep using the
LAN QR code.

**f. Worth doing while you are here**

- Keep the admin PIN on (Admin → **Access**).
- In the Tailscale admin console, disable *key expiry* for the server device
  (otherwise it drops off the tailnet every 90 days) and turn on device
  approval if others share your tailnet.
- Tailscale ACLs can restrict which of your devices may reach port 8088.

### Alternative: Cloudflare Tunnel

If you want a public HTTPS hostname instead of a VPN (so any browser works with
no client app), put **Cloudflare Access** in front of it so only your email
address can reach the page:

```bash
cloudflared tunnel login
cloudflared tunnel create printbridge
cloudflared tunnel route dns printbridge print.example.com
cloudflared tunnel run --url http://localhost:8088 printbridge
```

Then set `https://print.example.com` as the address in Admin → Settings → **Print
from anywhere**, and add an **Access** policy (email = you) in the Cloudflare
dashboard. Without that policy the page is public.

---

## 4. Print with nobody there

This is the part people expect and rarely get: you press **Print** from somewhere
else and the sheet comes out at home with no one touching anything.

What PrintBridge does for every job:

1. **Wake-up call** — before sending, the network printer gets a short
   `Get-Printer-Attributes`. A dozing printer wakes up while the document is
   still being prepared.
2. **Print over IPP** — the print-ready PDF is sent with media, duplex, copies
   and scaling. If the printer refuses the richer options it is retried with the
   essentials, so it prints instead of failing.
3. **If the printer is unreachable, the job waits instead of dying.** It is
   marked *Waiting for printer*, retried with a growing backoff (5 s, 10 s,
   20 s, 40 s… capped at 2 min), and it also fires the moment the printer
   becomes reachable again.
4. **How long it keeps trying** is your choice: Admin → Settings → **Print from
   anywhere** → *Keep trying for (minutes)*, default **30**. `0` restores
   one-attempt-then-fail behaviour.
5. **A server restart does not lose those jobs** — a job that was waiting while
   a printer was off resumes waiting after a reboot and prints when the printer
   returns.

You can watch all of it on the guest page (*Waiting for printer*, with a **Stop
trying** button) and on Admin → **Queue**.

**The one thing software cannot fix:** if the printer is switched off at the
wall, out of paper, or out of toner, it cannot print. A job stays waiting for its
window (30 min by default) and then fails with the reason, visible in the queue.
Set the window longer than the longest delay you expect — e.g. `480` minutes if
you often print overnight.

**Recommended settings for unattended use**

| Setting | Where | Value |
|---|---|---|
| Keep-alive | Printer → Network | 10 min |
| Keep trying for | Settings → Print from anywhere | 60–480 min |
| Print path | Printer → Automatic | resolves to IPP |
| Retention | Settings → Print defaults | ≥ 48 h (so you can retry later) |

---

## 5. Verify it works

```bash
# 1. The server answers at all
curl -s http://localhost:8088/api/v1/system/meta

# 2. From the phone on mobile data (with Tailscale on)
#    open  http://<machine>.<tailnet>.ts.net:8088  → the guest page loads

# 3. Tailscale is up on the server
tailscale status

# 4. PrintBridge sees the printer as ready
#    Admin → Printer → hero should read  ready · <printer name> · toner %
```

**Prove the whole Wi-Fi print path without touching your printer** — PrintBridge
ships a simulated network printer:

```bash
# terminal 1
npm run fake-printer          # a pretend IPP printer on 127.0.0.1:8631
# then, in Admin → Printer → Network, enter 127.0.0.1:8631 and print a test page

# or run the automated end-to-end test (starts/stops the simulator itself)
ADMIN_PIN=<your pin> npm run smoke:ipp
```

`npm run smoke:ipp` checks, against a running server: the printer's name, state
and supply levels are read back; a document is delivered over IPP with the right
media, duplex and copies; a picky printer still prints via the fallback; and a
job sent while the printer is away sits in *Waiting for printer*, then prints by
itself when the printer comes back.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Printer not found by discovery | 5 GHz SSID, guest network, or client isolation | Use the 2.4 GHz SSID; disable isolation; enter the IP manually |
| Printer shows offline in the Network tab | Printer asleep or IP changed | Press **Wake printer**; add a DHCP reservation |
| Job goes to the outbox instead of the printer | No usable print path (path still pinned to USB/spooler) | Printer → **Automatic**, or pin **Network printer (IPP)** |
| Job stuck at *Waiting for printer* | Printer off, out of paper, or unreachable | Check the printer; the job prints by itself once it answers. Lower/raise *Keep trying for* as needed |
| "Basic options only" in the job message | The printer refuses extended job attributes | Expected and handled — the document printed |
| Remote page does not load on the phone | Tailscale not installed/running on the phone, or key expired | Sign in the app; disable key expiry in the Tailscale console |
| Admin page asks for the PIN constantly over HTTPS | Session cookie dropped | Use the same hostname you set as the remote address; the cookie is `Secure` behind HTTPS, by design |
| Phones print, a laptop on a different Wi-Fi does not | Different network, no VPN | Install Tailscale on that laptop too |

---

## What the app does for you (2.1)

| Area | Where | What it adds |
|---|---|---|
| Address detection | `src/services/remote.js` | LAN + Tailscale discovery, effective remote URL, reachability probe |
| Admin UI | Settings → *Print from anywhere* | status, detected addresses, remote URL, `Test from here`, QR card for the road, retry window |
| Wi-Fi printing | `src/services/backends/ipp.js` | printer IP or full URL, wake-up call, correct attribute parsing, options fallback |
| Unattended jobs | `src/services/queue.js` | `waiting` state with backoff, bounded retry window, resume after restart |
| Self-management | `src/services/watchdog.js` | prints waiting jobs the moment the printer returns, keep-alive, queue adoption |
| Simulation & tests | `scripts/fake-printer.cjs`, `scripts/smoke-ipp.cjs` | a fake IPP printer and an end-to-end Wi-Fi test |
