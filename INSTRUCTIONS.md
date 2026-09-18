# Set this up on the laptop that owns the printer

This is the step-by-step for the machine that the printer is plugged into — the
one that turns the printer into something anyone can use from their phone.

Read it top to bottom the first time. **Steps 1–4 get you printing over USB
today; steps 5–7 move it to Wi-Fi** so the cable goes away. Everything is
reversible, and nothing here touches the internet.

> Running this on a machine that also holds the rest of the project? The folder
> is the whole product: the server, the three sites and this guide all live in
> it. Nothing needs to be downloaded from anywhere else.

---

## 0. What you need

| | |
|---|---|
| **The printer** | HP Neverstop Laser MFP 1200w (any USB printer works — the HP queue is just the one it looks for by name) |
| **This laptop** | Windows 10/11, always on, plugged into power |
| **A USB cable** | for the first setup only — Wi-Fi takes over later |
| **Node.js 18+** | `node --version` should print v18 or newer |
| **The Wi-Fi password** | the printer joins a **2.4 GHz** network only |

Two things worth writing down before you start:

- the printer's **Wi-Fi IP address** (step 6)
- the **admin PIN** PrintBridge prints when it first starts (step 1)

---

## 1. Start PrintBridge

From this folder:

```bash
npm install
npm start
```

The console prints a banner. Keep this window — it is the server:

```
  Main site    http://192.168.1.6:8088          (about · product · pricing · contact)
  Print site   http://192.168.1.6:8088/print    (what the QR points at)
  Admin site   http://192.168.1.6:8088/admin
  Admin PIN    482913    (first run — change it in Admin → Access)
```

There are **three sites** in one server, and they have different jobs:

| Site | Who it is for | What it does |
|---|---|---|
| `/` — **main site** | customers, the public | company, product, features, pricing, contact · two buttons: **Print** and **Log in** |
| `/print` — **print site** | whoever is standing at the printer | enter a printer code → upload → settings + preview → print → **token number** |
| `/admin` — **admin site** | you, the owner | the printer, every job, every code, prices, the PIN |

Open `http://localhost:8088/admin` on this laptop and sign in with that PIN.
You will not need the PIN again for 30 days on this machine.

---

## 2. Plug the printer in and let Windows install it

1. Connect the printer by USB and switch it on.
2. Print one page from Notepad (**Ctrl+P**) so Windows installs the driver queue.
   If it offers to download the HP driver, let it.
3. Back in **Admin → Printer**, the queue should appear by itself. Press
   **Locate** if it does not, then select the HP queue and press **Use this
   printer**.
4. If the page says no **silent print engine** was found, press **Install**.
   PrintBridge fetches SumatraPDF with `winget` (or a portable download as a
   fallback) and uses Adobe Acrobat/Reader if you already have one.
5. Press **Print test page**. Paper should come out. If it does, the hard part
   is done — everything after this is convenience.

**If the queue never appears:** check `Get-Printer` in PowerShell. A queue whose
name contains the printer model is the one to pick. PrintBridge adopts it on its
own when it recognises the name.

---

## 3. Register the walk-up printer (this is what makes a code)

A **printer code** (`PP-XXXX-XXXX`) is what a person types on the print site. It
belongs to a *walk-up printer*: a machine you are happy for other people to send
documents to.

Go to **Admin → Printers → Register a printer** and fill it in:

| Field | What to put |
|---|---|
| **Name** | the name people will recognise — “Ground floor copier” |
| **Category** | **Workspace** = free to print, one person's queue · **Shop / business** = priced per page and paid before printing |
| **Where to find it** | a line of help shown to the guest — “Next to reception” |
| **Destination** | the Windows queue from step 2 (this is the machine that really prints) |
| **What it can do** | the paper sizes, portrait/landscape, duplex, colour — the guest flow only ever offers what you tick here |
| **Prices** *(shop only)* | colour and black & white per page, in your currency |

Press **Register printer**. The code appears on its card.

Then press **Sticker** on that card: it prints a card with the code (and a QR
code that opens the print site with the code already filled in). **Stick it on
the printer.** That sticker *is* the guest experience — scan it, upload, collect.

> Two demo printers are seeded on a fresh install so you can try the guest flow
> before touching a printer: `PP-PTST-4WKS` (workspace, free) and `PP-PTST-4SHP`
> (shop, ₹4 colour / ₹1.50 B&W). Delete them on this page once your real printer
> has a code.

**Check it works:** on your phone, open `http://<this-laptop-ip>:8088/print`,
type the code, upload a PDF, press **Print**. A token number appears, the same
token is printed as the **first page** of the document, and the job shows up in
**Admin → Queue** and **Admin → Print codes** as *queued → printing → printed*.

---

## 4. Let the rest of the network in

Windows blocks incoming connections by default. Once, in an **elevated**
PowerShell:

```powershell
New-NetFirewallRule -DisplayName "PrintBridge" -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 8088 -Profile Private
```

Give this laptop a **DHCP reservation** in the router so its address never
changes — every printed sticker points at it.

---

## 5. Move the printer to Wi-Fi

The printer leaves the cable behind, and the laptop can then sit anywhere on the
same network. Do this **after** USB printing works, so you always have a working
path to fall back to.

**A. Join the network.** The 1200w is **2.4 GHz only** — if your router publishes
both bands under one name, either is fine for a phone but the printer may need
the 2.4 GHz one explicitly. Either:

- **HP Smart** (phone app) → *Add printer* → *Set up a new printer* → *Wi-Fi*,
  then enter the Wi-Fi password; or
- **WPS**: hold the **Wireless** button on the printer until the light blinks,
  then press **WPS** on the router within two minutes.

**B. Find its IP.** Hold the **Resume** button for about three seconds — the
printer prints a configuration report with its IP under *IPv4*. (Your router's
device list works too.) Write it down.

**C. Reserve that IP** in the router's DHCP settings, keyed to the printer's MAC
(the same report lists it). Without this the address can move and printing stops
until you fix the code.

**D. Point PrintBridge at it.** In **Admin → Printer**:

1. Set the print path to **Network / IPP**. Paste just the address —
   `192.168.1.50` is enough; PrintBridge fills in
   `ipp://192.168.1.50:631/ipp/print`.
2. Press **Wake printer** — it should report the printer's own name and its
   toner level, which proves PrintBridge is talking to it directly.
3. Set **Keep-alive** to **10 minutes** (Admin → Settings) so an idle Wi-Fi
   printer does not fall asleep.
4. Press **Print test page** one more time, then **unplug the USB cable** and
   print again. If paper comes out with the cable gone, you are done.

Any walk-up printer that still points at the old Windows queue can be edited on
**Admin → Printers** and switched to the network destination.

> **No printer at all yet?** Everything still works: jobs land in the **Outbox**
> as print-ready PDFs and are listed in the admin queue, so you can test the
> whole flow before hardware arrives.

---

## 6. Make it survive a reboot

The server is a Node process. Tailscale and the printer both come back on their
own after a reboot; Node does not. Once, in an **elevated** PowerShell:

```powershell
# Put the project somewhere that is not OneDrive first — a server writing
# uploads into a synced folder invites file locks. C:\printbridge is the sane home.
$action  = New-ScheduledTaskAction -Execute (Get-Command node).Source `
             -Argument "server.js" -WorkingDirectory "C:\printbridge"
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName "PrintBridge" -Action $action -Trigger $trigger `
  -RunLevel Highest -User "SYSTEM"
```

Then check it: `Stop-ScheduledTask -TaskName PrintBridge` and
`Start-ScheduledTask -TaskName PrintBridge`, and confirm the site answers again.

Settings that must survive a restart go in `./.env`:

```bash
PORT=8088
DATA_DIR=C:\printbridge\data
```

---

## 7. If you want it reachable from outside the building

The printer codes are the front door; putting the site on the internet is a
separate decision. The shape that works:

1. **This laptop stays the backend** — it is the only machine that can see the
   printer. Put it behind **Tailscale** (free for personal use), which gives you
   a real `https://…ts.net` address without opening a port.
2. **Publish the two public sites** (main + print) to Vercel:
   `PRINTBRIDGE_API_URL=https://<your-backend-host> npm run build:web`, then
   `vercel --prod`. The admin console is deliberately *not* in that bundle.
3. Set the build's `PRINTBRIDGE_ADMIN_URL` to the backend so the main site's
   **Log in** button points at the real console.

Full detail, including the CORS origin list the backend needs:
**[docs/deploy.md](docs/deploy.md)**.

---

## 8. When something is wrong

| Symptom | Fix |
|---|---|
| Job sits at *Waiting for printer* | printer asleep/off/out of paper, or its IP changed. It keeps retrying for the window in Settings → *Network & unattended printing* (default 30 min) and prints the moment the printer answers. **Wake printer** nudges it now. |
| Everything lands in the Outbox | no usable print path. Admin → Printer names the reason; fix the queue or the IP. |
| “No silent print engine” | press **Install** on Admin → Printer, or install SumatraPDF/Adobe Reader yourself. |
| A shop job refuses to print | it is unpaid by design. The guest picks colour or B&W, pays, then prints. |
| Guest says “No printer has that code” | the code is from a deleted or paused printer, or a typo. Codes are `PP-XXXX-XXXX` with no `0`/`O`/`1`/`I` in them. |
| Sign-in asks for the PIN you lost | delete `data/access.json` and restart — a fresh PIN prints in the console. |
| Phones cannot reach the site | the firewall rule in step 4, or the phone is on a different network / guest Wi-Fi with client isolation. |

### Prove it without touching hardware

```bash
npm run check          # syntax-check every source file
npm run smoke          # end-to-end: upload → preview → print, plus auth isolation
npm run smoke:walkup   # the workspace and shop guest flows, with ADMIN_PIN set
npm run fake-printer   # a simulated Wi-Fi printer, then: npm run smoke:ipp
```
