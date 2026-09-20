# Where PrintBridge should live

Short version: **the print service cannot move to a free cloud host**, because it
is the part that talks to the printer — the Windows spooler, IPP/AirPrint or CUPS
on the machine the printer is plugged into. A server in a data centre cannot see
a USB printer in your shop, and exposing a printer to the internet is not a thing
anyone should do. What can move is everything else, and this file is the exact
steps for making the public site and the machine reachable *wherever the people
using it are*, plus the honest options for "always on".

---

## 1. What is actually wrong today

Two separate failures, neither of them the websites:

| Symptom | Cause |
|---|---|
| `print-pi-three.vercel.app/print/` loads, then nothing works | The page is served fine (200, the real print page). It then calls the API at `https://aadrit.taila74510.ts.net`, and that answers **502** whenever your PC or the tunnel is down. The page is a shell until its backend answers. |
| `localhost:8088` — the local site and sign-in | Nothing was listening. The server was not running (it had been restarted away). Started again, and it now serves `/`, `/print/`, `/owner/` and `/api/*`. |
| `localhost:8088/admin` returns "The console lives in the app" | Deliberate, since the console became the desktop app: there is no web console on any host any more. `/owner` is the sign-in that still exists. |

The tailnet hostname is the important one. `*.ts.net` names are publicly
resolvable, but a plain Tailscale node is only *reachable* by devices in your
tailnet — a customer's phone is not one. So even with your PC on, a stranger
scanning the QR code gets 502. Two different jobs, two different fixes:

* make the machine **reachable from any browser**, while it is on → Path A
* make it **always on** → Path B (a box that stays on) or Path C (cloud + agent)

---

## 2. Path A — publish the machine you already have

Both options are free, need no port forwarding, and give you a stable HTTPS URL.
Printing keeps working exactly as it does now, because the service stays on the
machine with the printer.

### A1. Tailscale Funnel (you already run Tailscale — least work)

Funnel is Tailscale's own public ingress: it exposes *one* local port to the
public internet over HTTPS, from your existing node.

1. **Enable Funnel for the tailnet.** Tailscale admin console →
   *Access controls* → the policy file needs the funnel node attribute:

   ```jsonc
   "nodeAttrs": [
     { "target": ["*"], "attr": ["funnel"] }
   ]
   ```

   Then, on the machine's row in the admin console, **Funnel** must be allowed
   (it is off by default). No other change is needed.

2. **On the print machine**, with the service running on 8088:

   ```bash
   tailscale funnel --bg 8088
   tailscale funnel status          # shows the public URL it just took
   ```

   That publishes `https://<machine>.<tailnet>.ts.net/` → `localhost:8088`.
   `--bg` keeps it running after you close the terminal. Funnel only accepts
   ports 443, 8443 and 10000, and 8088 is *local* — Tailscale maps it for you.

3. **Point the website at it.** In the Vercel project → *Settings* →
   *Environment Variables*, set:

   | Name | Value |
   |---|---|
   | `PRINTBRIDGE_API_URL` | `https://<machine>.<tailnet>.ts.net` |
   | `PRINTBRIDGE_ADMIN_URL` | same value |

   Then *Deployments* → **Redeploy** (the build bakes those into `config.js`).

4. **Allow the website's origin on the machine.** In the print machine's `.env`:

   ```bash
   ALLOWED_ORIGINS=https://print-pi-three.vercel.app
   ```

   Restart the service. Without this the browser blocks every call.

5. **Verify from outside:**

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://<machine>.<tailnet>.ts.net/api/v1/system/meta
   # 200 means the world can reach the machine
   ```

**Trade-offs:** free, five minutes, no DNS. Funnel is rate-limited (a few Mbps)
and only publishes one port, which is plenty for a shop. It is still *your PC*:
shut the laptop and the site goes dark again — that is Path B's job.

### A2. Cloudflare Tunnel (free, needs a domain you own)

Better if you want `print.yourshop.com` and no bandwidth ceiling. Cloudflare's
free tier includes the tunnel itself; the domain is the only cost.

1. **Install `cloudflared`** on the print machine:

   ```powershell
   winget install --id Cloudflare.cloudflared
   ```

2. **Sign in and create the tunnel:**

   ```bash
   cloudflared tunnel login            # opens a browser, pick your domain
   cloudflared tunnel create printbridge
   ```

3. **Point a hostname at it** (Cloudflare creates the DNS record for you):

   ```bash
   cloudflared tunnel route dns printbridge print.yourshop.com
   ```

4. **Describe the route** in `%USERPROFILE%\.cloudflared\config.yml`:

   ```yaml
   tunnel: printbridge
   credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
   ingress:
     - hostname: print.yourshop.com
       service: http://localhost:8088
     - service: http_status:404
   ```

5. **Install it as a service** so it comes back after a reboot:

   ```powershell
   cloudflared service install
   ```

6. Steps 3–5 of A1 above, with `https://print.yourshop.com` in place of the
   tailnet URL: Vercel env vars, redeploy, `ALLOWED_ORIGINS`, verify.

> For a throwaway test only, `cloudflared tunnel --url http://localhost:8088`
> prints a random `*.trycloudflare.com` URL with no login. It changes every time
> you run it, so it is not something to put in Vercel.)

---

## 3. Path B — an always-on machine (the real "it always works")

Printing needs a computer that is awake, next to the printer, whenever somebody
walks up. Options, cheapest first:

| Box | Cost | Notes |
|---|---|---|
| The PC you have, left on | ₹0 | Set it not to sleep; the desktop app can hold it awake (*Tools → Keep this laptop awake*). Windows updates will still restart it eventually. |
| An old laptop or mini PC | ₹0 | Best value. Lid closed, power settings → never sleep. |
| Raspberry Pi 5 / any small Linux box | ~₹6–9k once | Silent, 5 W, runs for years. Printer should be on the network (IPP) or attached to the Pi. |
| A shop till PC you already run | ₹0 | If it is on all day anyway, it is the natural host. |

Steps for a dedicated box (Linux assumed; identical ideas on Windows):

1. **Node 20+**, then the project:

   ```bash
   sudo apt install -y nodejs npm
   git clone https://github.com/Aadrit1234/printbridge.git
   cd printbridge && npm install --omit=dev
   ```

2. **`.env`** in the project root:

   ```bash
   PORT=8088
   ADMIN_USER=admin                       # console sign-in; set it on the first run
   ADMIN_PASSWORD=<a real password>       # or leave both unset and read them from the first run's banner
   OPERATOR_KEY=<16+ random characters>  # mints licence codes — keep it secret, keep it here
   ALLOWED_ORIGINS=https://print-pi-three.vercel.app
   ```

3. **Run it as a service** so it starts at boot and restarts if it dies:

   ```ini
   # /etc/systemd/system/printbridge.service
   [Unit]
   Description=PrintBridge print service
   After=network-online.target cups.service

   [Service]
   WorkingDirectory=/home/pi/printbridge
   ExecStart=/usr/bin/node server.js
   Restart=always
   RestartSec=3
   User=pi

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo systemctl enable --now printbridge
   sudo systemctl status printbridge
   ```

4. **Give the printer to that box.** Either plug it in and let the app adopt the
   queue, or keep it on the network and let the IPP backend find it — the
   machine app's *Printers → Find* does both.

5. **Publish it** with Path A (Funnel or Cloudflare Tunnel), and the site works
   from anywhere while this box stays on — which it will, because nothing else
   uses it.

Windows equivalent: the desktop app does all of this for you. Install
**PrintBridge Workspace**, then *Tools → Start when I sign in to Windows* and
*Keep this laptop awake while printing*. That is the whole setup, and it is the
path most shops should take.

---

## 4. Path C — a free cloud host, and what it can and cannot do

Honest scope first:

* **A cloud instance can be the always-on front**: the public site, owner
  sign-in, licence redemption, the upload and checkout pages. It is up even when
  your shop is dark.
* **It cannot print.** It has no printer and no path to one. For the cloud to be
  useful rather than confusing, the machine in the shop has to *poll the cloud*
  for waiting jobs and print them locally. That is a relay — pull, not push —
  and **it does not exist in this codebase yet** (see §6).
* **Free tiers are not all equal.** What matters is whether the disk survives and
  whether the service stays awake:

  | Host | Free? | Awake? | Disk survives? |
  |---|---|---|---|
  | Oracle Cloud *Always Free* VM (ARM) | yes | **yes, always** | yes |
  | Google Cloud e2-micro free tier | yes | yes | yes |
  | Render free web service | yes | **sleeps after ~15 min idle** | **no — ephemeral** |
  | Koyeb / Fly.io | small credit | mostly | volume needed for real data |
  | Your own PC + Path A | yes | while the PC is on | yes |

  A shop's jobs, printers and sign-in hash live in `data/`. On an ephemeral disk they
  are gone at the next deploy — which for a business is worse than being offline.
  So if you go cloud, use a host with a **real disk** (the two VM rows) or mount
  a volume, and back `data/` up.

### If you still want it: the two useful shapes

**C1. A second, always-on instance as the public face** (no printing).

```bash
# on an always-free VM
git clone https://github.com/Aadrit1234/printbridge.git && cd printbridge
npm install --omit=dev
PORT=8088 HOST=127.0.0.1 DATA_DIR=/var/lib/printbridge \
ADMIN_PASSWORD=<password> OPERATOR_KEY=<key> \
ALLOWED_ORIGINS=https://print-pi-three.vercel.app node server.js
```

Put it behind Caddy or nginx for TLS (or use Cloudflare Tunnel from the VM), then
set the Vercel env vars to that hostname. You now have licences, accounts and the
public pages up 24/7 — but `/print/` there has no printer, so it can accept work
and cannot print it. That is exactly what §6 fixes.

**C2. The same instance also runs the shop's printer.** Only possible if the
"cloud" is really a machine in your shop (Path B) or if the printer is
network-reachable from wherever the server runs. If a printer is on your LAN,
keep the server on your LAN.

---

## 5. Changing where the API lives (checklist)

Whenever the public API URL changes, three places must agree:

1. **Vercel** → Settings → Environment Variables →
   `PRINTBRIDGE_API_URL` and `PRINTBRIDGE_ADMIN_URL` → then **Redeploy**
   (the value is baked into `dist/config.js` at build time).
2. **The machine's `.env`** → `ALLOWED_ORIGINS=` the exact origin of the site
   (`https://print-pi-three.vercel.app`), then restart the service.
3. **Verify both halves:**

   ```bash
   curl -s -o /dev/null -w 'api  %{http_code}\n' https://<public-api-host>/api/v1/system/meta
   curl -s https://print-pi-three.vercel.app/config.js | grep apiBase
   ```

   The first must be 200 and the second must name the same host.

---

## 6. What is worth building next

In order of how much trouble it saves:

1. **A clear "the printer machine is offline" state** on the public print page:
   right now an unreachable backend looks like a broken page. It should say which
   machine it is trying to reach, that it prints when the shop's machine is on,
   and offer a retry. Cheap, and it turns a support call into a message.
2. **The pull relay for Path C**: an agent on the shop's machine that claims
   waiting jobs from a cloud instance and prints them, so the upload and checkout
   work with the shop closed and the paper comes out when it opens. This is a
   real feature — a job passes through two servers, and the token page, the
   payment record and the retention clock all have to stay honest across it.
3. **Funnel/Cloudflare setup button in the app's Setup panel**: detect that the
   machine is reachable only on the LAN, say so on the checklist, and print the
   two commands for whichever tool is installed.
