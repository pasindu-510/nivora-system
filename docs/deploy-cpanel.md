# Deploy to cPanel (nivora.lk)

Production deployment runbook for the YourShop system on shared cPanel.

**Stack:** Django 5.2 + DRF (backend) · React/Vite SPA (frontend) · MySQL (cPanel) · Phusion Passenger via "Setup Python App".

**Layout:**

| Piece | Where it lives | Served by |
|---|---|---|
| SPA (built `frontend/dist/`) | `~/public_html/system/` + SPA `.htaccess` | Apache (document root of `system.nivora.lk`) |
| Django API (Passenger app) | `~/shopapi/` (app root) | `api.nivora.lk` via Passenger |
| Django static (`collectstatic`) | `~/public_html/system/static/` | Apache on `system.nivora.lk` |
| Uploaded media (business logos) | `~/public_html/system/media/` | Apache on `system.nivora.lk` |

Why static/media on the **SPA** origin: the API returns **relative** `/media/...` URLs (see `backend/core/views/business_logo.py`), which the browser resolves against the page origin (`system.nivora.lk`). Django writes files into `public_html/system/{static,media}`; Apache serves them on the SPA origin. The API subdomain serves **no** static files, so `STATIC_URL` is set to the absolute `https://system.nivora.lk/static/` for the Django admin / API docs pages.

---

## Phase 0 — Prerequisites (on the cPanel host)

1. Confirm **"Setup Python App"** exists: cPanel → **Software** → **Setup Python App**. (If you instead see **Application Manager**, the host is stock-cPanel — that path is different; contact support.)
2. Confirm a Python **3.10–3.13** option appears in the dropdown (tested against Django 5.2). If only ≤3.9 is listed, open a ticket asking the host to install Python 3.12 via CloudLinux LVE Manager.
3. (Recommended) Enable **SSH**: cPanel → **Security → SSH Access** → Manage → *Enable*. You said there's an SSH tab — if that's the browser **Terminal** (Advanced → Terminal) it also works for the commands below.
4. Local machine: **Node.js ≥ 18** (for the frontend build) and a way to upload files (`scp`/`rsync`, or cPanel File Manager).

---

## Phase 1 — Domains, subdomains, DNS, SSL

1. cPanel → **Domains** → **Create A New Domain**. On a shared host your DNS is usually already pointed at the server for `nivora.lk`; **add subdomains**:
   - `system.nivora.lk` → document root `~/public_html/system` (default for the `system` subdomain)
   - `api.nivora.lk` → document root `~/public_html/api` (will be overridden by Passenger)
2. If DNS is managed elsewhere (registrar/Cloudflare): add `A` records for both subdomains → server IP (shown on the cPanel dashboard under "Shared IP Address" or your welcome email). Keep **DNS-only** (grey cloud on Cloudflare) until SSL is issued, then you may proxy.
3. **SSL:** cPanel → **Home → SSL/TLS Status** → *Run AutoSSL*. Wait for both subdomains to show a valid certificate. (If Cloudflare proxies before issuance, AutoSSL's HTTP-01 can fail — issue first, proxy later.)

---

## Phase 2 — MySQL database (cPanel)

1. cPanel → **Databases → MySQL Database Wizard** (or *MySQL Databases* / *Manage My Databases*).
2. **New Database:** `shopapi` → stored as `<cpaneluser>_shopapi`. Note the exact prefixed name.
3. **MySQL Users:** username `shop`, strong password (save it — cPanel never shows it again).
4. **Add User To Database:** select both, grant **ALL PRIVILEGES** → Make Changes.
5. Record: DB name `<cpaneluser>_shopapi`, user `<cpaneluser>_shop`, password, host = `localhost`.

> The prefixed name matters — MySQL 5.7+ limit is 32 chars including the `USERNAME_` prefix.

---

## Phase 3 — Upload the backend code

Target: `~/shopapi/` must be the **Passenger application root** containing `passenger_wsgi.py`, `manage.py`, `shopapi/`, `core/`, `requirements.txt`.

**Option A — File Manager (no SSH):**
1. Zip the **contents of `backend/`** locally (`backend/passenger_wsgi.py`, `manage.py`, `shopapi/`, `core/`, …) into `shopapi.zip`.
2. cPanel → **File Manager** → home dir → **Upload** `shopapi.zip` → right-click → **Extract**.
3. Rename the extracted folder to `shopapi` if needed (it must be `~/shopapi/passenger_wsgi.py`).

**Option B — scp/rsync (SSH):**
```bash
# from your machine, inside the backend/ folder
scp -r . user@nivora.lk:shopapi
# or rsync --exclude .venv --exclude db.sqlite3
```

Then create the `.env` file (Phase 4) and the `tmp/` dir for Passenger restarts:
```bash
mkdir -p ~/shopapi/tmp && touch ~/shopapi/tmp/restart.txt
```

---

## Phase 4 — Production `.env`

Copy the template to a real `.env` **on the server**:

```bash
cd ~/shopapi
cp .env.production.example .env
nano .env        # or upload via File Manager / scp from backend/.env.production.example
chmod 600 .env
```

Fill in the `CHANGE_ME` values:

```env
DJANGO_SECRET_KEY=<run the command below>
DEBUG=False
ALLOWED_HOSTS=api.nivora.lk,localhost,127.0.0.1

DB_ENGINE=mysql
DB_NAME=<cpaneluser>_shopapi
DB_USER=<cpaneluser>_shop
DB_PASSWORD=<password from Phase 2>
DB_HOST=localhost
DB_PORT=3306
DB_CONN_MAX_AGE=0

CORS_ALLOWED_ORIGINS=https://system.nivora.lk

STATIC_ROOT=/home/<cpaneluser>/public_html/system/static
MEDIA_ROOT=/home/<cpaneluser>/public_html/system/media
STATIC_URL=https://system.nivora.lk/static/
```

Generate the secret key **locally** (or on the server):
```bash
python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"
```

> `MEDIA_URL` stays `/media/` (set in `settings.py`) — it must remain **relative** so the frontend resolves it against the SPA origin.

---

## Phase 5 — Create the Passenger app (Setup Python App)

1. cPanel → **Software → Setup Python App** → **Create Application**:

   | Field | Value |
   |---|---|
   | Python version | 3.12 (any 3.10–3.13) |
   | Application root | `shopapi` (→ `/home/<user>/shopapi`) |
   | Application URL | `api.nivora.lk` (subdomain), base URI `/` |
   | Application startup file | `passenger_wsgi.py` |
   | Application Entry point | `application` |
   | Passenger log file | `shopapi/passenger_wsgi.log` (or leave default) |

2. **Important:** cPanel's template may **overwrite `passenger_wsgi.py`** on creation. Re-assert ours afterwards:
   - If using git: `git checkout -- passenger_wsgi.py`
   - Otherwise: re-upload `backend/passenger_wsgi.py` → `~/shopapi/passenger_wsgi.py`.
3. Click **Restart** (or `touch ~/shopapi/tmp/restart.txt`).

---

## Phase 6 — Install dependencies, migrate, collectstatic

Via **SSH** or **cPanel Advanced → Terminal**:

```bash
# Path to the venv python is shown on the Setup Python App page under
# "Enter to the virtual environment". Typical:
export VENV_PY=$HOME/virtualenv/shopapi/3.12/bin/python

$VENV_PY -m pip install -r ~/shopapi/requirements.txt --upgrade
```

**If `mysqlclient` fails to build** (shared hosting often lacks `mysql_config`/build-headers inside CageFS — error like `OSError: mysql_config not found`):
```bash
$VENV_PY -m pip install pymysql
# then set DB_DRIVER=pymysql in ~/shopapi/.env  (the shim is already in settings.py)
```

Then:
```bash
cd ~/shopapi
$VENV_PY manage.py migrate --noinput
$VENV_PY manage.py collectstatic --noinput
$VENV_PY manage.py createsuperuser   # platform super_admin (no business)
touch tmp/restart.txt
```

> `restart.txt` only bounces Passenger workers — it does **not** run migrations. Migrate first, restart after.

---

## Phase 7 — Build & upload the frontend

**Locally** (`.env.production` already points `VITE_API_URL` at `https://api.nivora.lk/api`):

```bash
cd frontend
npm install
npm run build     # outputs dist/ with the production API URL baked in
```

**Upload `dist/`** → `~/public_html/system/` so `system.nivora.lk/index.html` is the app.

**Create the SPA `.htaccess`** at `~/public_html/system/.htaccess` (React Router history mode + real static/media passthrough):

```apache
Options -MultiViews -Indexes
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /

  # Preserve the Authorization header (JWT) on internal rewrites
  RewriteCond %{HTTP:Authorization} ^(.+)
  RewriteRule .* - [E=HTTP_AUTHORIZATION:%1]

  # Real files/dirs (Vite assets, /static/, /media/) pass through untouched
  RewriteCond %{REQUEST_FILENAME} -f [OR]
  RewriteCond %{REQUEST_FILENAME} -d
  RewriteRule ^ - [L]

  # Everything else → the SPA shell
  RewriteRule ^ /index.html [QSA,L]
</IfModule>
<IfModule mod_dir.c>
  DirectoryIndex index.html
</IfModule>
```

**Media uploads:** ensure `~/public_html/system/media/` exists and is writable by the cPanel user (it is by default on shared hosting). Django behavior: media files go to `~/public_html/system/media/business_logos/…`; Apache serves them at `https://system.nivora.lk/media/…` — same origin as the SPA, so the relative URLs in API responses work.

---

## Phase 8 — Smoke test (before login)

```bash
# Health endpoint (public, DB-free) — must return {"status":"ok"}
curl -i https://api.nivora.lk/api/health/

# SPA shell + a real static file
curl -I https://system.nivora.lk/
curl -I https://system.nivora.lk/static/admin/css/base.css    # if admins use /admin/
```

Also open both URLs in a browser and watch the **topbar pill**: it should flip from "Checking…" to "Online". Killing the backend / network flips it to "Offline" ~1.5s later — that's the `useConnectionState()` heartbeat working against `/api/health/`.

---

## Phase 9 — Bootstrap tenant data (fresh start)

The platform starts empty. Create the first shop via the **Django admin** (super_admin):

1. Open `https://api.nivora.lk/admin/` → log in with the superuser from Phase 6.
2. **Businesses → Add**: name, address, phone, tax rate, `installment_interest_rate`, cashier discount cap, max installments (optional).
3. **Branches → Add**: pick the business, branch name.
4. **Users → Add**: `username`, set `role = business_admin`, assign the business + branch, set a password. (Use `Super User status` only if the person also needs Django admin access; regular staff log in via the SPA.)
5. (Optional) **Upload the business logo** → sign in at `system.nivora.lk` as that user; the cashier/manager flow starts from there.

---

## Phase 10 — Verify end-to-end

1. Open `https://system.nivora.lk/login` → sign in as the business_admin.
2. Topbar shows **Online** (SPA → `api.nivora.lk/api/health/` + `/auth/me/` working, CORS passing).
3. Create a sale (single-payment and installment) on `/sales/new`; open its invoice in **Print/Download** — single-payment sales must show **only the invoice with "Paid in full"** (the Session 9 bugfix), installment sales show invoice + receipt.
4. Upload a business logo in Manage Business → confirm it renders (media on same origin).
5. Recount a daily figure vs `/api/reports/cash/` later if needed.

---

## Updating / redeploying later

**Backend only** — upload changed files, then:
```bash
cd ~/shopapi && $VENV_PY -m pip install -r requirements.txt --upgrade
$VENV_PY manage.py migrate --noinput
$VENV_PY manage.py collectstatic --noinput
touch tmp/restart.txt
```

**Frontend only** — rebuild locally, upload `dist/` over `~/public_html/system/`, done (Apache serves it instantly).

**Optional git workflow** — if you enable *Files → Git Version Control*, the checked-in `.cpanel.yml` at the repo root automates pip/migrate/collectstatic/restart on push (adjust `DEPLOYDIR`/venv path to your layout).

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `502 Bad Gateway` on `api.nivora.lk` | `passenger_wsgi.py` was overwritten by cPanel template → re-upload ours, restart; check `~/shopapi/stderr.log` or the Passenger log on the app page |
| `ModuleNotFoundError: shopapi` | Packages installed into the wrong interpreter → always use `$VENV_PY`, never bare `pip` |
| `MySQLdb` / `mysqlclient` build error | Use the PyMySQL path (Phase 6) + `DB_DRIVER=pymysql` |
| `DisallowedHost` 400 | Missing/extra host in `ALLOWED_HOSTS` (must include `api.nivora.lk`) |
| CORS error in browser console | `CORS_ALLOWED_ORIGINS` must be exactly `https://system.nivora.lk` (no trailing slash) |
| Logos 404 | `MEDIA_ROOT` points somewhere Apache can't see; media must live under `public_html/system/media` |
| Customer ID photo broken | Photos live in `PRIVATE_MEDIA_ROOT` (default `backend/private_media`, outside `public_html`) and load via signed `/api/customers/<id>/id-card-photo/?sig=…` links that expire after 1 h — refresh the page. Run `migrate` after updating so migration 0006 moves old photos out of `public_html`. |
| Django admin has no CSS | `STATIC_URL` must be the absolute SPA origin URL and `collectstatic` must have run |
| 503 "Service Unavailable" on the API, `stderr.log` shows `lswsgi_wrapper: … /opt/alt/python3XX/bin/lswsgi: No such file or directory` | LiteSpeed's Python connector is missing on the server — only the host can install it (open a ticket quoting the log line) |
| `OperationalError (2013, 'Lost connection to MySQL server')` | Host kills idle MySQL connections: set `DB_CONN_MAX_AGE=0` in `.env`; create the superuser non-interactively (`read -s DJANGO_SUPERUSER_PASSWORD; export DJANGO_SUPERUSER_PASSWORD; manage.py createsuperuser --noinput --username X --role super_admin`) |
| Page loads but login hangs | Topbar "Checking…" stuck → backend down or `ALLOWED_HOSTS`/CORS wrong; check health URL directly |

---

## Security checklist (shared hosting)

- [ ] `DEBUG=False`, strong `DJANGO_SECRET_KEY`, `.env` chmod 600
- [ ] SSL enforced: consider `.htaccess` redirect `http → https` on both subdomains
- [ ] Only business_admin accounts are superusers; cashiers get `cashier` role via the SPA (as designed)
- [ ] If you later add Cloudflare proxying, re-run AutoSSL after switching to DNS-only
- [ ] Keep `media/` writable-upload-only if the host offers a "no script execution" toggle for `~/public_html/`

### Optional post-deploy hardening (safe after the site is verified live)

`manage.py check --deploy` reports only recommendations — the app boots fine as-is.
If you want to silence them later, add to `shopapi/settings.py` **after** the site
is confirmed working over HTTPS (do NOT enable HSTS before https is fully proven):

```python
SECURE_SSL_REDIRECT = True                 # also requires the https .htaccess rule
SESSION_COOKIE_SECURE = True               # admin panel runs over https only
CSRF_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = 31536000             # read Django docs before enabling
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
```
Then redeploy the backend (`passenger_wsgi.py` sibling is unchanged) and restart.