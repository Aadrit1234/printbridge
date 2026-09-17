# Deploy: GitHub, a live backend, and the frontend on Vercel

Three separate jobs, and it matters which one goes where:

| Piece | Where it has to live | Why |
|---|---|---|
| **Backend** (the print server) | the machine that can see the printer — your always-on box | it must open a TCP connection to a printer that sits on your home LAN. A cloud function cannot reach `192.168.1.50` |
| **Public URL for the backend** | a tunnel from that box (Tailscale Funnel, Cloudflare Tunnel) | so the browser can reach it over HTTPS without opening a router port |
| **Frontend** (`public/`) | anywhere static — Vercel, Netlify, Cloudflare Pages | it is plain ES modules and CSS; it just needs to *talk* to the backend |

**Vercel cannot host the backend.** Not a configuration problem — Vercel Functions
cap request bodies at **4.5 MB** (your upload limit is 25 MB), cap execution at
300 s, have no persistent disk for `data/`, and above all have no route to your
home network. Deployed there, PrintBridge would accept uploads and print nothing.

So: **backend live on your box behind a tunnel, frontend live on Vercel.**

---

## 0. Requirements

- The repo pushed to GitHub (section 1).
- A free **Tailscale** account with the backend box signed in (section 2).
- A free **Vercel** account (section 3).
- Node 18+ on the backend box.

---

## 1. Push to GitHub

The repo ships with a `.gitignore` that keeps `data/` (your documents, jobs and
the admin PIN hash), `node_modules/` and build output out of git. Check that
before the first commit:

```bash
git init -b main
git add -A
git status --short          # make sure data/ and node_modules/ are NOT listed
git commit -m "PrintBridge: self-hosted print server"
```

Create the repo and push (GitHub CLI, already authenticated):

```bash
gh repo create printbridge --public --source=. --remote=origin --push
```

Or with plain git, after creating an empty repo in the GitHub web UI:

```bash
git remote add origin https://github.com/<you>/printbridge.git
git push -u origin main
```

Later changes:

```bash
git add -A && git commit -m "..." && git push
```

> **Never commit `data/`.** `data/access.json` holds the admin PIN hash and
> `data/jobs.json` + `data/uploads/` hold everything anyone has printed.

---

## 2. Make the backend live

### 2a. Run it on the always-on box

Set it up to start at boot (Windows Task Scheduler, systemd, launchd or Docker —
copy-paste units are in [anywhere-access.md](anywhere-access.md#2-make-the-server-always-on)).
Confirm it answers locally:

```bash
curl -s http://localhost:8088/api/v1/system/meta
```

### 2b. Give it a public HTTPS URL — Tailscale Funnel (free, no domain)

Funnel publishes one local port at a stable
`https://<machine>.<tailnet>.ts.net` address with a real certificate. Your
devices do not need Tailscale for this — that is the difference between
`serve` (private) and `funnel` (public).

```bash
# once, on the backend box
curl -fsSL https://tailscale.com/install.sh | sh     # Windows/macOS: the app
sudo tailscale up
tailscale status                                     # note the machine name
```

Enable Funnel for the tailnet when the CLI asks (it opens a browser link and
adds the `funnel` node attribute to your policy file), then:

```bash
sudo tailscale serve --bg 8088      # keep it HTTPS-ready
sudo tailscale funnel 8088          # publish it
tailscale funnel status             # prints the public https:// URL
```

That URL — `https://printbridge.<tailnet>.ts.net` — is your live backend. Test it
from a phone on mobile data:

```bash
curl -s https://printbridge.<tailnet>.ts.net/api/v1/system/meta
```

Funnel notes: it only listens on 443/8443/10000, only over TLS, and its traffic
is bandwidth-limited (fine for documents). Enable HTTPS certificates and MagicDNS
in the Tailscale admin console if the CLI complains.

**Prefer a private URL?** Use `tailscale serve --bg 8088` instead of `funnel` —
then only your own tailnet devices can reach it, and you would skip Vercel for
guests (they would need Tailscale too).

**Want an auth wall in front?** Cloudflare Tunnel + Access requires a domain you
own; see [anywhere-access.md](anywhere-access.md#alternative-cloudflare-tunnel).
With Access, the frontend origin allowlist below still applies.

### 2c. Allow the frontend origin

The browser refuses cross-origin reads unless the backend names the frontend's
origin. On the backend box, add an environment variable and restart:

```bash
ALLOWED_ORIGINS=https://printbridge.vercel.app
```

- Linux/systemd: add `Environment=ALLOWED_ORIGINS=https://…` to the unit and
  `systemctl restart printbridge`.
- Windows Task Scheduler: set it as a machine/user environment variable, then
  restart the task (or wrap the action in `cmd /c "set ALLOWED_ORIGINS=… && node server.js"`).
- Docker: add it to the `environment:` block.

Comma-separate several origins (a Vercel preview deployment and your production
domain, say). Leave it unset for a LAN-only install: no CORS headers are sent at
all, and the admin cookie stays `SameSite=Strict`.

Verify from a terminal — the preflight, then a real request:

```bash
curl -i -X OPTIONS https://<backend>/api/v1/jobs \
  -H "Origin: https://printbridge.vercel.app" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: x-device-id" | grep -i access-control
```

You want `Access-Control-Allow-Origin: https://printbridge.vercel.app` (never `*`).

---

## 3. Put the frontend on Vercel

The repo includes `vercel.json` and `scripts/build-web.cjs`, which copy `public/`
to `dist/` and point the frontend at the backend. There is no bundler and no
native dependency in that path — the build is a file copy, so it cannot fail on
Vercel's builder.

### 3a. Import the project

1. <https://vercel.com/new> → **Import Git Repository** → pick `printbridge`.
2. Framework preset: **Other**. Build settings come from `vercel.json`
   (build `node scripts/build-web.cjs`, output `dist`).
3. Add the environment variable **before the first deploy**:

   | Name | Value | Example |
   |---|---|---|
   | `PRINTBRIDGE_API_URL` | public origin of the backend | `https://printbridge.tailnet-1234.ts.net` |
   | `PRINTBRIDGE_ADMIN_URL` | optional, only if the admin console lives elsewhere | leave empty |

   Tick all environments (Production, Preview, Development).

   To build a bundle that the backend itself serves, use the literal value
   `same-origin` — no other value is valid for a self-hosted install.

4. **Deploy**. You get `https://printbridge-<hash>.vercel.app`, and after adding
   a domain, something like `https://printbridge.vercel.app`.
5. **Write that URL into `ALLOWED_ORIGINS` on the backend and restart it**
   (section 2c). Nothing works until both sides name each other.

### 3b. Or from the CLI

```bash
npm i -g vercel
cd /path/to/printbridge
vercel login
vercel env add PRINTBRIDGE_API_URL production     # paste the tunnel URL
vercel --prod
```

### 3c. What ends up on Vercel

- `/` — the guest app (upload, preview, My prints, PWA install).
- `/admin` — the admin console. It signs in against the backend API.

The build writes `dist/config.js` with the backend origin; that is the only
difference from the self-hosted copy. `dist/deployment.json` records what the
bundle was built against — handy when you are not sure what is live.

---

## 4. Verify the whole thing

```bash
# 1. backend is live and public
curl -s https://<backend>/api/v1/system/meta

# 2. the frontend names the right backend
curl -s https://<frontend>/config.js

# 3. the backend allows the frontend
curl -sI -X OPTIONS https://<backend>/api/v1/jobs \
  -H "Origin: https://<frontend>" -H "Access-Control-Request-Method: POST" | grep -i access-control
```

Then, in a browser on the Vercel URL:

1. Upload a document → the preview renders (that is a cross-origin image fetch).
2. Press **Print** → the job is accepted; the printer state updates live (that is
   a cross-origin SSE stream).
3. Open `/admin` → sign in with the PIN → the queue shows every job.
4. From a phone on mobile data: load the Vercel URL, print something, and watch
   it come out at home.

---

## 5. Things that will bite you

**The admin session is a cookie.** When the admin console is on Vercel and the
API is on the tunnel, that cookie travels cross-site, which needs
`SameSite=None; Secure` — PrintBridge sets it automatically for allowlisted
origins. Two consequences:

- **The backend must be HTTPS.** A plain `http://192.168.1.6:8088` backend cannot
  receive that cookie; admin sign-in from the Vercel page will silently fail.
  Use the Funnel/Cloudflare (or any TLS) URL.
- **Safari and Firefox block third-party cookies by default**, and Chrome limits
  them. On those browsers the admin console on Vercel may not hold a session. The
  guest page is unaffected (it identifies devices with a header, not a cookie).

  **The robust fix:** keep the admin console same-origin with the API by
  proxying it through Vercel, which also keeps `SameSite=Strict`. Add to
  `vercel.json` (replace the host with your tunnel URL), then redeploy:

  ```json
  "rewrites": [
    { "source": "/admin", "destination": "/admin/index.html" },
    { "source": "/api/admin/:path*", "destination": "https://<backend>/api/admin/:path*" }
  ]
  ```

  With this, the browser only ever talks to the Vercel origin for admin calls, so
  cookies are first-party everywhere — Safari included. Do **not** proxy the guest
  API the same way: uploads over 4.5 MB exceed Vercel's request limit, which is
  exactly why the guest app talks to the tunnel directly.

**Public means public.** Funnel exposes the guest page to anyone who has the URL,
and printing is open to anyone who can reach the server — that is the feature, but
it is your paper and toner. Keep `adminProtect` on, and consider adding
Cloudflare Access in front if that worries you (see
[anywhere-access.md](anywhere-access.md)).

**Preview deploys have a different origin.** Every Vercel preview URL is a new
origin, so either add each one to `ALLOWED_ORIGINS` or turn previews off for the
project.

**The URL must not change.** Tailscale Funnel names are stable; Cloudflare quick
tunnels (`*.trycloudflare.com`) are not — a changed backend URL stops being in
`ALLOWED_ORIGINS` and stops matching `config.js`, so use a named tunnel.

---

## 6. Updating

- **Backend:** pull on the always-on box and restart the service (or `git pull &&
  systemctl restart printbridge`).
- **Frontend:** `git push` — Vercel rebuilds on every push to `main`.
- Both are versioned together; the version is printed in Admin → Settings →
  About and in `dist/deployment.json`.

## 7. Alternative: no Vercel at all

The backend serves the frontend itself (`public/` is static and cached properly),
so the tunnel URL alone is a complete, working deployment — one URL for guests
and one for `/admin`, with no CORS, no cross-site cookies and nothing to configure.
Use Vercel when you want a CDN-cached, separately-versioned frontend on your own
domain; use the tunnel directly when you want the simplest thing that works.
