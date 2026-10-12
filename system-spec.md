# System Specification — Multi-tenant Electric & Kitchen Appliances Shop Management System

> **Status:** Final (all decisions confirmed by the owner, 2026-09-24)
> **Working plan file:** `.omo/plans/electric-shop-system.md`
> **This document:** the authoritative reference for models, architecture, and deployment.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Tenancy & Roles](#3-tenancy--roles)
4. [Data Models](#4-data-models)
5. [Business Rules & Calculation Logic](#5-business-rules--calculation-logic)
6. [REST API Map](#6-rest-api-map)
7. [React Application](#7-react-application)
8. [Security, Storage & Scheduled Jobs](#8-security-storage--scheduled-jobs)
9. [Deployment Guidelines (register.lk cPanel)](#9-deployment-guidelines-registerlk-cpanel)
10. [Confirmed Decisions & Scope Boundaries](#10-confirmed-decisions--scope-boundaries)

---

## 1. Overview

A multi-tenant (SaaS) management system for an electric home & kitchen appliances selling shop. The shop:

- Sells items (stock-tracked, brand/category classified) **and** allows customers to **pay in installments**
- Runs multiple **branches** and reports sales per branch
- Places **purchase orders to suppliers** with partial-delivery receiving
- Needs **role-based authentication** for staff (not customers)
- Is used by **many businesses**, each created by a super admin, each with its own dashboard, users, and data isolation
- Requires financial visibility: accurate **FIFO profit**, a **balance sheet**, and a **cash-flow forecast**

### In scope
Stock, sales, installments, customers (+optional ID photos), users/roles, branches, seasonal & spot discounts, suppliers & purchase orders, expenses, supplier payments, cash accounts, capital entries, P&L / balance sheet / cash-flow / VAT reports, super-admin business management.

### Out of scope (explicit)
Double-entry general ledger, audited GAAP balance sheet, payroll/EPF-ETF, fixed-asset depreciation, customer-facing portal, multi-currency.

---

## 2. Architecture

### 2.1 Stack

| Layer | Choice | Rationale |
|---|---|---|
| Backend | **Django 5 + Django REST Framework** | Built-in auth/RBAC, ORM, migrations, admin, uploads |
| API auth | `djangorestframework-simplejwt` (JWT) | Token auth for the React SPA |
| Database | **MySQL / MariaDB** | The only reliable DB on cPanel shared hosting |
| Frontend | **React 18 + Vite + React Router + Axios + Tailwind CSS + Recharts + TanStack Query** | Shop management UI |
| Super admin | **Django Admin** (customized) | Business & audit management, no extra frontend |
| File storage | Local `media/` served by Apache | Customer ID photos (optional field) |
| WSGI server | **Phusion Passenger** (via cPanel "Setup Python App") | Runs Django as an always-on server |
| Background jobs | **cPanel cron** → Django management commands | Reminders & alerts |

**Anti-goals** (not available/reliable on shared hosting): Docker, Redis, WebSockets, PostgreSQL, long-running worker processes.

### 2.2 URL layout (single domain)

```
https://yourshop.lk        → React SPA  (static build in public_html, Apache)
https://api.yourshop.lk    → Django API (Passenger Python app)
        │
        └── /api/auth/*, /api/sales/*, /api/stock/*, /api/reports/* ...
```

- Subdomains are free with the included domain; AutoSSL covers them
- Cross-origin (React → api) resolved via `django-cors-headers`
- Alternative (no CORS): mount the Python app at `yourshop.lk/api` — requires a PATH_INFO fix in `passenger_wsgi.py`; subdomain approach avoids this

### 2.3 Logical flow

```
React SPA (cashier/branch/manager/admin screens)
   │  JWT over HTTPS
   ▼
Django REST API  ── TenantMiddleware ── TenantModelViewSet (auto-scoped)
   │                      │
   ├─ Auth/RBAC ──────────┤
   ├─ Catalog/FIFO stock ─┤── MySQL (single DB, shared schema, business_id on all rows)
   ├─ Sales/Installments ─┤
   ├─ Bookkeeping ────────┤
   └─ Reports (P&L, BS, CF, VAT)
```

---

## 3. Tenancy & Roles

### 3.1 Tenancy model
Single database, **shared schema**. Every business-level table carries a `business_id` foreign key. A `TenantMiddleware` resolves the current business from the authenticated user; a custom manager + `TenantModelViewSet` automatically scope **every** queryset and auto-assign `business` on create. Super admins have no business.

**Hierarchy:** `SuperAdmin → Business → Branch → User → transactions (sales/stock/customers/expenses)`

### 3.2 Roles

| Role | Scope | Capabilities |
|---|---|---|
| `super_admin` | Global | Create/manage businesses (Django Admin only), site-wide audit |
| `business_admin` | Own business | Everything: users, branches, catalog, stock, suppliers, POs, customers, sales, installments, expenses, finance settings, all reports |
| `manager` | Own business | Catalog, stock, suppliers, POs, customers, sales, installment collection, expenses, P&L/BS/CF/tax reports — **no** user/branch management, no finance settings |
| `cashier` | In-branch (optionally) | Create sales (spot discount ≤ cap), create customers, collect installment payments — **no** prices editing, no reports, no expenses |

- One user belongs to exactly one business; `business` FK nullable only for super admins
- `is_staff` = `super_admin` only → Django Admin accessible only by super admins; business staff log in via the React app only
- Branch FK on users is nullable = "whole business"

---

## 4. Data Models

> 26 models. All business-level models include `business = FK(Business, CASCADE)` (omitted below for brevity) and all models carry `created_at` / `updated_at`.

### 4.1 Auth & tenant

**Business**
| Field | Type | Notes |
|---|---|---|
| name | Char | |
| address | Text | |
| phone / email | Char / Email | |
| logo | Image, nullable | |
| is_active | Bool | deactivation disables all its users |
| tax_rate | Decimal, default 0 | VAT % (e.g. 15); prices are tax-inclusive |
| cashier_discount_cap | Decimal, default 20 | max % a cashier may discount |
| created_by | FK User | super admin who created it |

**Branch** — `business`, `name`, `address`, `phone`, `is_active`

**User** (custom model replacing default auth)
| Field | Type | Notes |
|---|---|---|
| username / password | standard | |
| full_name, phone | Char | |
| role | Choice | super_admin / business_admin / manager / cashier |
| business | FK nullable | null = super_admin (global) |
| branch | FK nullable | null = whole business |
| is_active | Bool | |

**RoleConstants** — module-level enum constants used by permission classes (no DB table).

### 4.2 Catalog & stock (FIFO lot-based)

**Category** — `business`, `name`, `parent (FK self, nullable)` → infinite tree

**Brand** — `business`, `name`

**Item**
| Field | Type | Notes |
|---|---|---|
| code | Char | unique per business |
| name | Char | |
| category | FK | |
| brand | FK | |
| cost_price | Decimal | reference/default (truth lives in lots) |
| selling_price | Decimal | |
| stock_quantity | Int | denormalized; source of truth = Σ lots |
| low_stock_threshold | Int | alert level |
| is_active | Bool | |
| image | Image, nullable | |

**StockLot** — the FIFO engine
| Field | Type | Notes |
|---|---|---|
| branch | FK | |
| item | FK | |
| quantity_total | Int | original received qty |
| quantity_remaining | Int | current left = stock level |
| unit_cost | Decimal | this lot's purchase cost |
| source | Choice | OPENING / PURCHASE / ADJUSTMENT / RETURN |
| reference | Char | PO no / invoice no |
| received_at | DateTime | used for FIFO ordering (oldest first) |

**StockMovement** — audit trail
| Field | Type | Notes |
|---|---|---|
| branch, item | FK | |
| type | Choice | IN / OUT / ADJUST / SALE |
| quantity | Int | +/– |
| reference | Char | invoice / PO no |
| note | Text | |
| created_by | FK User | |

**LotAllocation** — links each sold unit to the lot it came from
| Field | Type | Notes |
|---|---|---|
| stock_lot | FK | |
| sale_item | FK | |
| quantity | Int | |
| unit_cost | Decimal | |

### 4.3 Customers

**Customer**
| Field | Type | Notes |
|---|---|---|
| name | Char | |
| phone | Char | |
| nic | Char, nullable | national ID |
| address | Text, nullable | |
| id_card_photo | Image, **null/blank** | optional — NOT required |
| created_at | | |

### 4.4 Sales & installments

**Sale**
| Field | Type | Notes |
|---|---|---|
| branch | FK | |
| customer | FK, nullable | null = walk-in (no account) |
| invoice_no | Char | `INV-{year}-{business}-{seq}` |
| subtotal | Decimal | Σ line totals before discounts |
| discount_type | Choice | PERCENT / AMOUNT |
| discount_value | Decimal | |
| discount_amount | Decimal | computed |
| tax_rate | Decimal | snapshot from Business at sale time |
| tax_amount | Decimal | price-inclusive math |
| total_cost | Decimal | grand total |
| is_single_payment | Bool | true = paid in full immediately |
| down_payment | Decimal | |
| number_of_installments | Int | 0 for single payment |
| remaining_cost | Decimal | |
| status | Choice | OPEN / CLOSED / CANCELLED |
| installment_frequency | Choice | WEEKLY / MONTHLY / CUSTOM (default MONTHLY) |
| installment_interval_days | Int | used when CUSTOM |
| created_by | FK User | |

**SaleItem** — `sale`, `item`, `quantity`, `unit_price`, `line_total`, **`fifo_cost`** (unit cost frozen from lots at sale time → drives COGS/P&L/stock valuation)

**Installment** — one row per scheduled payment:
`sale`, `number`, `due_date`, `amount`, `paid_amount`, `is_paid`, `paid_date`

**Payment** — money-in ledger:
`sale (nullable)`, `installment (nullable)`, `amount`, `method (CASH/CARD/TRANSFER)`, `cash_account (FK)`, `received_by (FK User)`, `note`, `created_at`

### 4.5 Discounts

**SeasonalDiscount** — `business`, `name`, `scope (ALL/CATEGORY/BRAND/ITEM)`, `target_id` (FK per scope, null for ALL), `discount_percentage`, `start_date`, `end_date`, `is_active`

### 4.6 Suppliers & purchase orders

**Supplier** — `business`, `name`, `contact_person`, `phone`, `email`, `address`, `is_active`

**Purchase** (the PO — "orders done by us")
| Field | Type | Notes |
|---|---|---|
| branch | FK | receiving branch |
| supplier | FK | |
| order_no | Char | `PO-{year}-{business}-{seq}` |
| status | Choice | DRAFT / ORDERED / PARTIALLY_RECEIVED / RECEIVED / CANCELLED |
| expected_delivery_date | Date | |
| notes | Text | |
| ordered_by | FK User | |

**PurchaseItem** — `purchase`, `item`, `quantity` (ordered), `received_quantity` (accumulated), `unit_cost`, `total`

**PurchaseReceipt** — a delivery against a PO: `purchase`, `receipt_no`, `received_by`, `note`, `created_at`

**PurchaseReceiptItem** — `receipt`, `purchase_item`, `quantity` → creates `StockLot(PURCHASE)` + `StockMovement(IN)` per item; PO auto-advances `PARTIALLY_RECEIVED → RECEIVED` when quantities match

**PO workflow:** `DRAFT → ORDERED → [partial deliveries via receipts] → RECEIVED` (cancel anywhere before fully received)

### 4.7 Bookkeeping — money out, cash & capital

**CashAccount** — `business`, `name` (Main Cash, Bank X…), `type (CASH/BANK)`, `opening_balance`, `is_active`

**ExpenseCategory** — `business`, `name` (Rent, Salaries, Utilities, Marketing, Transport, Other), `is_active`

**Expense** — `business`, `branch`, `category`, `description`, `amount`, `expense_date`, `cash_account`, `paid_by (FK User)`, `note`

**SupplierPayment** — `business`, `supplier`, `purchase (nullable: open payment vs against a PO)`, `amount`, `payment_date`, `cash_account`, `paid_by`, `note` — supplier outstanding = Σ PO totals − Σ payments

**CapitalEntry** — `business`, `date`, `type (OWNER_IN / OWNER_OUT)`, `amount`, `note` → opening capital + owner drawings

**RecurringExpense** — `business`, `branch`, `category`, `description`, `amount`, `frequency (MONTHLY/WEEKLY/CUSTOM days)`, `next_due_date`, `is_active` → feeds cash-flow forecast; (v2: cron auto-creates Expense on due date)

---

## 5. Business Rules & Calculation Logic

1. **Sale calculation:** line items → subtotal → on-the-spot discount → auto-apply active seasonal discounts (item-level where scope matches) → `total_cost`.

2. **Installment split:** remaining = total − down payment. Split into N installments (N−1 equal, last absorbs rounding). Due dates spaced by frequency: WEEKLY (7d) / MONTHLY (30d) / CUSTOM (N days). Lives in **one service function** so UI and API stay consistent.

3. **FIFO stock engine:** every stock IN creates a `StockLot`. A sale consumes lots **oldest-first** in one transaction:
   - validate quantity (insufficient → sale blocked)
   - decrement `quantity_remaining`, create `LotAllocation` rows
   - freeze `SaleItem.fifo_cost`
   - cancelled sale → reverse allocations → exact restock to original lots
   - every change also writes a `StockMovement`

4. **Cashier discount cap:** spot discount ≤ cap (default 20% for cashier; manager/admin unlimited) — configurable per Business.

5. **Invoice/PO numbering:** `INV-{year}-{business_id}-{seq}` and `PO-{year}-{business_id}-{seq}`.

6. **VAT:** prices tax-inclusive. `tax_amount = total_cost − total_cost/(1 + tax_rate)` (snapshot of rate at sale time). Tax report = Σ tax_amount by period/branch.

7. **P&L (cash-basis, FIFO COGS):**
   - Revenue = Σ payments received in period (down payments + installments)
   - COGS = Σ (qty × `SaleItem.fifo_cost`) in period — exact, auditable to lots
   - Gross profit = Revenue − COGS
   - Net profit = Gross − Σ Expenses − Σ SupplierPayments

8. **Balance sheet (as-of date, management-level):**
   - Assets = Σ cash account balances (opening ± in/out) **+** accounts receivable (Σ OPEN sale remaining_cost) **+** stock value (Σ remaining lots × unit_cost)
   - Liabilities = supplier payables (Σ unpaid PO balances) **+** VAT collected not yet remitted
   - Equity = Σ (OWNER_IN − OWNER_OUT) + retained profit to date
   - **Enforced: Assets = Liabilities + Equity**

9. **Cash-flow forecast (30/60/90 days, weekly buckets):**
   - In = unpaid Installments by due_date
   - Out = PO remaining balances by expected_delivery_date + RecurringExpense next_due_date cycle
   - → net projected cash per week (planning tool, assumes on-time payments)

---

## 6. REST API Map

Prefix `/api/`. JWT required except `login/`. All viewsets inherit the tenant-scoping base.

| Endpoint | Method | Roles | Notes |
|---|---|---|---|
| `/api/auth/login/` | POST | all | returns access + refresh |
| `/api/auth/refresh/` | POST | all | |
| `/api/auth/me/` | GET | all | user + business + branch + role |
| `/api/dashboard/summary/` | GET | all (cashier: own branch) | today's sales, low stock, due installments, top items |
| `/api/dashboard/branch-sales/` | GET | admin/manager | date range |
| `/api/installments/due/` | GET | admin/manager/cashier | overdue + due-soon |
| `/api/branches/` | CRUD | admin (cashier read) | |
| `/api/users/` | CRUD | business_admin | |
| `/api/categories/` | CRUD | admin/manager | tree |
| `/api/brands/` | CRUD | admin/manager | |
| `/api/items/` | CRUD+filters | admin/manager (cashier read) | q, category, brand, low_stock |
| `/api/stock-movements/` | read/create | admin/manager | FIFO-aware adjustments |
| `/api/stock-lots/` | GET | admin/manager | qty remaining per cost lot, lot age |
| `/api/suppliers/` | CRUD | admin/manager | |
| `/api/purchases/` | CRUD | admin/manager | DRAFT→ORDERED, status filter |
| `/api/purchases/<id>/receive/` | POST | admin/manager | partial/full → lots + stock IN |
| `/api/purchases/<id>/cancel/` | POST | admin/manager | before fully received |
| `/api/customers/` | CRUD+photo | admin/manager/cashier | multipart for photo |
| `/api/customers/<id>/history/` | GET | admin/manager/cashier | purchases + outstanding |
| `/api/sales/` | POST/GET | create: all, read: scoped | items[], customer, discount, installment config |
| `/api/sales/<id>/` | GET | scoped | items (+fifo_cost), installments, allocations |
| `/api/sales/<id>/installments/` | POST | admin/manager/cashier | record payment → Payment + remaining_cost |
| `/api/sales/<id>/cancel/` | POST | admin/manager | reverses lots, closes |
| `/api/payments/` | GET | admin/manager | money-in ledger |
| `/api/seasonal-discounts/` | CRUD | admin/manager | |
| `/api/cash-accounts/` | CRUD | business_admin | + opening balances |
| `/api/capital-entries/` | CRUD | business_admin | |
| `/api/expense-categories/` | CRUD | admin/manager | |
| `/api/expenses/` | CRUD+filters | admin/manager | branch, category, date |
| `/api/recurring-expenses/` | CRUD | admin/manager | |
| `/api/supplier-payments/` | CRUD | admin/manager | reduces outstanding |
| `/api/suppliers/<id>/ledger/` | GET | admin/manager | POs + payments + balance |
| `/api/reports/profit-loss/` | GET | admin/manager | Revenue, FIFO COGS, Gross, Expenses, Net |
| `/api/reports/balance-sheet/` | GET | admin/manager | as-of date |
| `/api/reports/cash-flow/` | GET | admin/manager | 30/60/90d weekly buckets |
| `/api/reports/tax/` | GET | admin/manager | VAT filing summary |

DRF specifics: `TenantModelViewSet` base (auto-scope + auto-assign business), role permission classes, pagination, `drf-spectacular` OpenAPI docs.

---

## 7. React Application

### 7.1 Routes (22)

```
/login
/(authenticated layout: role-aware sidebar + topbar)
  /dashboard            — KPIs, sales-by-branch chart, low-stock, due installments
  /sales/new            — POS: item search, cart, customer select/create,
                          spot discount (role-capped), single vs installment,
                          down payment, N installments (weekly/monthly/custom)
  /sales                — list (branch/date/status filters) + detail drawer
  /sales/:id            — detail, installments table, collect payment
  /installments         — due/overdue table, collect payment
  /customers            — list, create (optional ID photo), detail + history
  /items                — list + low-stock badges, create/edit
  /categories           — tree editor
  /brands               — CRUD
  /stock/purchases      — POs: create, list by status, place, cancel
  /stock/receive        — receive PO delivery (partial/full) → live stock
  /stock/lots           — per-item lot view (qty, cost, age)
  /stock/movements      — audit trail
  /suppliers            — CRUD + ledger (POs, payments, balance)
  /expenses             — list/create, category filter
  /expenses/recurring   — recurring templates (rent, salaries)
  /settings/finance     — (business_admin) cash accounts, opening balances, capital entries
  /promotions           — seasonal discounts CRUD
  /reports              — branch sales, installment collection, P&L,
                          BALANCE SHEET, CASH FLOW, TAX (date-range tabs)
  /users                — (business_admin) users, roles, branches
  /branches             — (business_admin) branch CRUD
```

### 7.2 Technical decisions
- **Auth:** login → JWT (httpOnly cookie preferred; localStorage acceptable v1) → Axios interceptor adds `Authorization`, auto-refresh on 401
- **Server state:** TanStack Query (caching, invalidation on mutations)
- **Session:** minimal React context
- **Shared components:** DataTable, Modal, FormField, StatCard, PhotoUpload (client-side compress to ~200 KB)
- **Role gating:** route guards + menu filtering from `/api/auth/me/`

---

## 8. Security, Storage & Scheduled Jobs

### Security
- JWT auth, role permission classes per endpoint
- Tenant scoping enforced server-side (never trust client-side scoping)
- Super admin = only `is_staff`; business staff are API-only
- Production: `DEBUG=False`, strong secret key, HTTPS (AutoSSL)

### Storage
- Customer ID photos → `media/customers/` on server disk (optional field)
- Static files → `public_html/static/` via `collectstatic`
- Disk budget 7 GB — compress uploads client-side

### Scheduled jobs (cPanel cron → management commands)
```cron
0 9 * * *  source ~/virtualenv/shop-api/3.12/bin/activate && cd ~/shop-api && python manage.py send_installment_reminders
0 8 * * *  source ~/virtualenv/shop-api/3.12/bin/activate && cd ~/shop-api && python manage.py send_low_stock_alerts
```
(v2: `generate_recurring_expenses`)

---

## 9. Deployment Guidelines (register.lk cPanel)

### 9.1 Create the Python app
cPanel → **Software → Setup Python App → Create Application**

| Field | Value |
|---|---|
| Python version | `3.12.14` |
| Application root | `shop-api` (→ `/home/USERNAME/shop-api`) |
| Application URL | `api.yourdomain.lk` |
| Application startup file | `passenger_wsgi.py` |
| Application entry point | `application` |

The venv is auto-created by cPanel (path shown on the app page, e.g. `/home/USERNAME/virtualenv/shop-api/3.12/`). **Never upload a local venv — install on the server.**

### 9.2 `passenger_wsgi.py` (one line)
```python
from shopapi.wsgi import application   # project's own wsgi module
```
Do **not** use gunicorn/uvicorn — Passenger IS the WSGI server.

### 9.3 Dependencies & database (SSH → Terminal)
```bash
source /home/USERNAME/virtualenv/shop-api/3.12/bin/activate && cd /home/USERNAME/shop-api
pip install -r requirements.txt
# django, djangorestframework, djangorestframework-simplejwt, django-cors-headers,
# Pillow, drf-spectacular, python-dotenv
# DB driver: mysqlclient  (fallback: PyMySQL + pymysql.install_as_MySQLdb())
```
cPanel → **MySQL® Databases**: create DB + user (host `localhost`), grant all → credentials in `.env`.

### 9.4 Production settings
```python
DEBUG = False
ALLOWED_HOSTS = ["yourshop.lk", "api.yourshop.lk"]
STATIC_ROOT = "/home/USERNAME/public_html/static"
MEDIA_ROOT  = "/home/USERNAME/public_html/media"
STATIC_URL  = "/static/"
MEDIA_URL   = "/media/"
```
```bash
python manage.py migrate
python manage.py collectstatic
```
CORS (React → api, different origins):
```python
# settings.py
CORS_ALLOWED_ORIGINS = ["https://yourshop.lk"]
```

### 9.5 React deployment
```bash
npm run build      # → dist/
```
Upload `dist/*` contents into `public_html/` so `https://yourshop.lk` serves the SPA.

### 9.6 Restart & verify
Every code change → cPanel → Setup Python App → **Restart** (or `touch passenger_wsgi.py`). Logs: Passenger log file field on the app page.
```bash
curl https://api.yourshop.lk/api/auth/login/    # expect JSON
# https://yourshop.lk → React SPA
```

### 9.7 Gotchas
- 🔴 Restart after every change (Passenger caches the app)
- 🔴 Never `DEBUG=True` in production — a crash can expose source on cPanel
- 🔴 Binary wheels must compile on the server (CloudLinux)
- 🔴 Keep static/media OUTSIDE the app root so Passenger never serves source
- 🔴 Subdirectory URLs (`yourshop.lk/api`) need a PATH_INFO fix — use a subdomain instead

---

## 10. Confirmed Decisions & Scope Boundaries

### Confirmed (owner, 2026-09-24)
1. Currency: **LKR**, no multi-currency ✅
2. UI language: **English** (i18n-ready for Sinhala/Tamil later) ✅
3. Installments: **weekly or monthly** presets + custom days ✅
4. One user = one business (super admin global) ✅
5. Customer ID photo: **optional** field, stored on server disk ✅
6. Cashier spot-discount cap: **20%** (configurable per business) ✅
7. Supplier management + **purchase orders** with partial deliveries ✅
8. **Full bookkeeping**: expenses, supplier payments, P&L, VAT summary ✅
9. **FIFO COGS**: lot-based, exact cost per sale, auditable ✅
10. **Balance sheet** (management-level) + **cash-flow forecast** for planning ✅

### Scope boundaries
- Balance sheet is management-level — no fixed-asset depreciation, no audited GAAP format; new equipment recorded as an expense
- Cash-flow forecast assumes scheduled payments/deliveries happen on time (planning tool)
- No double-entry ledger, no payroll, no customer portal, no multi-currency — each is a separate future project

### Build order (implementation phases)
1. Django scaffold (custom User, Business/Branch, DRF+JWT, MySQL, `.env`)
2. Tenancy core (middleware, TenantModelViewSet, permissions, isolation tests)
3. Django Admin customization (super admin only)
4. Catalog & PO API **with FIFO lots**
5. Customer API (photo upload, history)
6. Sales API (FIFO allocation, installment split, cancel/reverse)
7. Bookkeeping & reports APIs (P&L, balance sheet, cash flow, tax)
8. React scaffold (Vite, auth, layout)
9. React pages (parallel by domain)
10. Deploy per Section 9

**Verification gates:** Django test suite (tenant isolation, FIFO multi-lot allocation, sale/installment math, P&L & balance-sheet math), seed command, passing React build, end-to-end test on a staging subdomain before cutover.