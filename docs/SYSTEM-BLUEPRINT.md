# System Blueprint — Multi-tenant Appliance Shop Management System

> **Purpose of this file.** A complete, language-neutral description of what the
> system *actually does today* (reverse-engineered from the code on 2026-11-24),
> written so that a developer or AI agent can (a) improve the current Django +
> React code, or (b) **rewrite the backend and/or frontend in any language**
> (PHP/Laravel, Node, Go, …) without reading the original source.
>
> Where the code and the older design doc (`system-spec.md`) disagree, **this file
> follows the code**. Known defects are listed in §12 — a rewrite should fix them,
> not copy them.

---

## Table of contents

1. [What the product is](#1-what-the-product-is)
2. [Architecture](#2-architecture)
3. [Tenancy, roles and permissions](#3-tenancy-roles-and-permissions)
4. [Data model](#4-data-model)
5. [Business rules and calculations](#5-business-rules-and-calculations)
6. [API contract](#6-api-contract)
7. [Reports](#7-reports)
8. [Frontend (React SPA)](#8-frontend-react-spa)
9. [Platform admin and bootstrap flow](#9-platform-admin-and-bootstrap-flow)
10. [Deployment notes](#10-deployment-notes)
11. [Rewrite guide](#11-rewrite-guide)
12. [Known bugs and gaps](#12-known-bugs-and-gaps)
13. [Repository map](#13-repository-map)

---

## 1. What the product is

A **SaaS (multi-business) management system for electric home & kitchen appliance
shops** in Sri Lanka (currency LKR, timezone `Asia/Colombo`). Each shop
("business") is fully isolated from the others.

Core capabilities:

| Area | What it does |
|---|---|
| Catalog | Items (unique code per business), hierarchical categories, brands, selling/cost price, low-stock threshold, item image |
| Stock | Per-branch **FIFO cost lots**; stock-in via purchase-order receipts, opening stock, manual adjustments; full movement audit trail |
| Sales (POS) | Multi-line sale, seasonal (automatic) discount per item, invoice-level spot discount (percent or amount), tax (VAT), single payment **or installment plan** |
| Installments | Down payment + N equal installments at a fixed day interval; partial payments; roll-forward overpayment; one-time late interest on under-paid installment |
| Customers | Name, phone, NIC, address, optional ID-card photo; purchase history + outstanding balance |
| Suppliers | Supplier master, purchase orders (draft → ordered → partially received → received / cancelled), supplier payments, supplier ledger (payable balance) |
| Bookkeeping | Cash/bank accounts with derived balances, expenses + categories, recurring expenses (for forecasting), owner capital in/out |
| Reports | Sales by day/month, profit & loss (FIFO COGS), balance sheet, 13-week cash-flow forecast, VAT summary, low stock, dashboard cards, per-branch sales |
| Users | Staff logins with roles: business_admin, manager, cashier; platform super_admin creates businesses |
| Printing | A4 invoice / installment receipt, print + PDF download from the browser |
| Offline indicator | Topbar pill (Online/Offline/Checking) from a 5 s heartbeat to `/api/health/` (full offline sync is only a spec: `docs/offline-sync-spec.md`) |

Out of scope (by design): double-entry general ledger, payroll, depreciation,
customer portal, multi-currency, refunds/returns workflow, VAT input credit.

---

## 2. Architecture

```
Browser ──► SPA (static files, React)  system.nivora.lk  (Apache/LiteSpeed serves files)
   │
   └──► REST API (JSON, JWT)           api.nivora.lk/api/...  (Django via Passenger/lswsgi)
             │
             └──► MySQL/MariaDB (utf8mb4)   (SQLite in local dev)
Uploaded files: written by the API into  public_html/system.nivora.lk/media/
                served by the web server at https://system.nivora.lk/media/...
```

* **Stateless API** — every request carries `Authorization: Bearer <access JWT>`.
  No server sessions are used by the SPA (Django sessions exist only for the
  built-in `/admin/` site).
* **Tokens**: access + refresh JWT (HS256, signed with `DJANGO_SECRET_KEY`).
  SPA stores both in `localStorage` (`yourshop.access`, `yourshop.refresh`).
  On HTTP 401 the SPA calls refresh once and retries; on refresh failure it logs out.
* **Media URLs are relative** (`/media/business_logos/abc.png`). The SPA resolves
  them against its own origin, therefore media must be served from the SPA domain.
* **Money** is stored as fixed-point decimals (2 dp) and serialized as **strings**
  (`"1500.00"`). Quantities are integers.
* **Timestamps** are timezone-aware (stored UTC, business logic uses
  `Asia/Colombo` local date for "today", due dates, report day buckets).
* **Pagination**: page-number, default `page_size=20`, client may request up to
  `page_size=100`. List responses: `{count, next, previous, results:[...]}`.
  Exception: endpoints documented below as returning a plain array/object.
* **Search**: query param `q` (not `search`). Ordering: `ordering=<field>` or `-<field>`.
* **Errors**: DRF style — `{"detail": "message"}` or field map
  `{"field": ["message", ...]}`, or `{"non_field_errors": [...]}`. 400 validation,
  401 unauthenticated/expired token, 403 role denied, 404 not found / other tenant.
* **Hosting constraints** (shared cPanel): no Docker, Redis, WebSockets, workers;
  scheduled jobs only via cPanel cron.

Environment variables (backend `.env`):

| Var | Meaning | Default |
|---|---|---|
| `DJANGO_SECRET_KEY` | signing key (JWT too) | insecure dev key |
| `DEBUG` | `True/False` | False |
| `ALLOWED_HOSTS` | comma list | `localhost,127.0.0.1,testserver` |
| `DB_ENGINE` | `mysql`/`mariadb` → MySQL, anything else → SQLite | — |
| `DB_NAME, DB_USER, DB_PASSWORD, DB_HOST, DB_PORT, DB_CONN_MAX_AGE` | MySQL connection | — |
| `DB_DRIVER` | `pymysql` → use PyMySQL instead of mysqlclient | — |
| `JWT_ACCESS_MINUTES`, `JWT_REFRESH_DAYS` | token lifetimes | 60 / 7 |
| `CORS_ALLOWED_ORIGINS` | SPA origin(s) | `http://localhost:5173` |
| `CORS_ALLOW_ALL_ORIGINS` | bool | False |
| `STATIC_ROOT, STATIC_URL, MEDIA_ROOT` | file locations (MEDIA_URL fixed `/media/`) | local dirs |

Frontend env: `VITE_API_URL` (e.g. `https://api.nivora.lk/api`), baked in at build time.

---

## 3. Tenancy, roles and permissions

### 3.1 Tenancy

* `Business` is the tenant. Every business-level table has a non-null `business_id`.
* The tenant for a request is **always `request.user.business`** — never taken from
  the URL, query or body.
* All list/detail queries are filtered by that business; a row of another business
  returns **404** (not 403).
* On create, `business` is forced to the caller's business.
* Foreign keys in payloads (branch, customer, item, cash_account, category, supplier,
  purchase, parent, seasonal-discount target …) are validated as belonging to the
  caller's business (400 otherwise). `paid_by`/`received_by`/`created_by` are always
  set by the server.
* A business with `is_active = false` is locked out: login returns 400 and every
  role-guarded endpoint returns 403 `{"detail": "This business account is deactivated."}`.
* `super_admin` has `business = null`; all tenant endpoints return empty lists /
  403 for them. They only use `/api/admin/*` and the Django `/admin/` site.

### 3.2 Roles

| Role | Scope |
|---|---|
| `super_admin` | Platform owner. Creates businesses and any user. No shop data access. |
| `business_admin` | Full control of own business incl. users, branches, cash accounts, capital, tax/interest settings, logo. |
| `manager` | Catalog, stock, suppliers/POs, expenses, discounts, reports, cancel sales. |
| `cashier` | POS sales, customers, installment collection, read items (no cost price). |

`User.branch` exists (home branch) but is **not enforced** — any staff may sell from
any branch of the business.

### 3.3 Capability matrix (backend, authoritative)

Legend: ✅ allowed, R read-only, — denied (403).

| Resource / action | cashier | manager | business_admin | super_admin |
|---|---|---|---|---|
| health, login, refresh | ✅ (public) | ✅ | ✅ | ✅ |
| `auth/me` | ✅ | ✅ | ✅ | ✅ |
| branches | R | R | ✅ | — (empty) |
| categories, brands | R | ✅ | ✅ | — |
| items list/detail | R (no `cost_price`) | ✅ | ✅ | — |
| item create/update/delete, stock adjust, stock-ins | — | ✅ | ✅ | — |
| back-dating (stock in, sale, installment payment; §5.14) | — | ✅ | ✅ | sets the limit |
| customers (+history) | ✅ | ✅ | ✅ | — |
| sales list/detail/create | ✅ (no `fifo_cost`) | ✅ | ✅ | — |
| pay installment | ✅ | ✅ | ✅ | — |
| cancel sale | — | ✅ | ✅ | — |
| payments (read) | R | R | R | — |
| installments/due | ✅ | ✅ | ✅ | — |
| suppliers, purchases, supplier-payments, ledger | — | ✅ | ✅ | — |
| stock-lots, stock-movements | — | ✅ | ✅ | — |
| cash-accounts | R | R | ✅ | — |
| expense-categories | — | R | ✅ | — |
| expenses, recurring-expenses | — | ✅ | ✅ | — |
| capital-entries | — | — | ✅ | — |
| seasonal-discounts | — | ✅ | ✅ | — |
| reports/*, dashboard/* | — | ✅ | ✅ | — |
| finance-settings (tax & interest rate) | — | — | ✅ | — |
| business/logo GET | ✅ | ✅ | ✅ | ✅ |
| business/logo POST | — | — | ✅ | — |
| users (own business) | — | — | ✅ | — |
| admin/businesses, admin/users | — | — | — | ✅ |

Frontend route guards mirror this (§8.2). Cashier lands on `/sales/new`; managers
and business admins on `/dashboard`; super admin on `/admin/businesses`.

---

## 4. Data model

Conventions:
* Every table has an auto-increment integer `id`.
* **(T)** = tenant table: also has `business_id` (FK Business, NOT NULL, cascade
  delete), `created_at` (set on insert), `updated_at` (set on every save).
* `decimal(m,2)` = fixed-point money/percent. `str(n)` = varchar(n).
* "cascade" / "protect" / "set null" describe ON DELETE behaviour.

### 4.1 Business (tenant)

| Field | Type | Null | Default | Notes |
|---|---|---|---|---|
| name | str(200) | no | | |
| address | text | no | '' | |
| phone | str(30) | no | '' | |
| email | email | no | '' | |
| logo | file path | yes | | stored under `business_logos/` |
| is_active | bool | no | true | false → staff cannot log in; API returns 403 |
| tax_rate | decimal(5,2) | no | 0 | VAT %, default for new sales |
| installment_interest_rate | decimal(5,2) | no | 0 | one-time late-interest % (§5.4) |
| installments_enabled | bool | no | true | false → installment sale create returns 400; existing plans stay payable |
| installment_monthly_interest_rate | decimal(5,2) | no | 0 | flat monthly interest added to new plans (§5.4) |
| required_guarantors | uint | no | 0 | 0, 1 or 2 per installment sale |
| min_down_payment_percent | decimal(5,2) | no | 0 | 0–99; installment sales need `down_payment >= ceil(total × % / 100 to the next 100)` (§5.3) |
| cashier_discount_cap | decimal(5,2) | no | 20 | max spot discount % for cashiers (enforced on sale create) |
| max_installments | uint | yes | null | null = unlimited; enforced on sale create |
| max_users | uint | yes | null | null = unlimited; ≥1 if set |
| max_branches | uint | yes | null | null = unlimited; ≥1 if set |
| max_categories, max_brands, max_items | uint | yes | null | null = unlimited; ≥1 if set; create → 400 `{"detail": "… limit reached (N)…"}` |
| item_images_enabled | bool | no | true | false → item image upload is rejected and the SPA hides images (stored files are kept) |
| backdate_limit_days | uint | yes | 0 | 0 = back-dating off, null = unlimited, N = up to N days back (§5.14); super_admin only |
| created_by | FK User | yes | | set null |
| created_at, updated_at | datetime | | | |

Ordering: name.

### 4.2 Branch (T)

| Field | Type | Null | Default |
|---|---|---|---|
| name | str(200) | no | |
| address | text | no | '' |
| phone | str(30) | no | '' |
| is_active | bool | no | true |

### 4.3 User (also the login account)

Standard auth user (`username` unique, hashed `password`, `email`, `first_name`,
`last_name`, `is_staff`, `is_superuser`, `last_login`, `date_joined`) plus:

| Field | Type | Null | Notes |
|---|---|---|---|
| full_name | str(200) | no ('') | |
| phone | str(30) | no ('') | |
| role | enum `super_admin \| business_admin \| manager \| cashier` | no | |
| business | FK Business | yes | cascade; null only for super_admin |
| branch | FK Branch | yes | set null; home branch (informational) |
| is_active | bool | no (true) | inactive users cannot log in |

Password rule for API-created users: min 8 chars.

### 4.4 Catalog

**Category (T)**: `name str(200)`, `parent FK Category null (cascade)` — tree.
**Brand (T)**: `name str(200)`.

**Item (T)**

| Field | Type | Default | Notes |
|---|---|---|---|
| code | str(50) | | **unique per business** |
| name | str(200) | | |
| category | FK Category, null | | set null |
| brand | FK Brand, null | | set null |
| cost_price | decimal(12,2) | 0 | **last cost**: updated by stock in and PO receipts (a back-dated entry never overwrites a later one); default for adjustment / opening lots |
| selling_price | decimal(12,2) | 0 | list price before seasonal discount |
| stock_quantity | int | 0 | **business-wide cached total** (all branches) |
| low_stock_threshold | int | 5 | low stock when `stock_quantity <= threshold` |
| is_active | bool | true | |
| image | file, null | | `items/` |

### 4.5 Stock

**StockLot (T)** — one FIFO cost layer.

| Field | Type | Notes |
|---|---|---|
| branch | FK Branch (cascade) | lot location |
| item | FK Item (cascade) | |
| quantity_total | int | received qty |
| quantity_remaining | int | decremented by sales |
| unit_cost | decimal(12,2) | |
| source | enum `OPENING \| PURCHASE \| ADJUSTMENT \| RETURN` | RETURN unused |
| reference | str(100) | receipt no / 'OPENING' / note |
| received_at | datetime | default now; FIFO order key |

FIFO order: `received_at ASC, id ASC`.

**StockMovement (T)** — audit trail.
`branch FK`, `item FK`, `type enum IN|OUT|ADJUST|SALE` (OUT unused),
`quantity int` (signed: sale negative, receipt positive), `reference str(100)`,
`note text`, `created_by FK User null`. Ordering `-created_at`.

**LotAllocation (T)** — which lot fed which sale line.
`stock_lot FK (cascade)`, `sale_item FK (cascade)`, `quantity int`, `unit_cost decimal(12,2)`.

### 4.6 Customer (T)

`name str(200)`, `phone str(30)`, `nic str(20)` (national ID), `address text`,
`id_card_photo file null` (`customers/`). Ordering name.

### 4.7 Sales

**Sale (T)**

| Field | Type | Default | Notes |
|---|---|---|---|
| branch | FK Branch | | **protect** |
| customer | FK Customer, null | | set null; null = walk-in |
| invoice_no | str(50) | | **globally unique**, `INV-<year>-<seq4>` |
| subtotal | decimal(12,2) | 0 | Σ line totals (after seasonal discount) |
| discount_type | enum `PERCENT \| AMOUNT` | PERCENT | spot discount kind |
| discount_value | decimal(12,2) | 0 | % or LKR as entered |
| discount_amount | decimal(12,2) | 0 | computed LKR |
| tax_rate | decimal(5,2) | 0 | % applied |
| tax_amount | decimal(12,2) | 0 | |
| total_cost | decimal(14,2) | 0 | **grand total payable** (name is historical — it is a price, not a cost) |
| is_single_payment | bool | true | false = installment sale |
| down_payment | decimal(12,2) | 0 | single payment: = total |
| number_of_installments | int | 0 | |
| remaining_cost | decimal(12,2) | 0 | **outstanding balance** incl. interest |
| status | enum `OPEN \| CLOSED \| CANCELLED` | OPEN | CLOSED when remaining_cost reaches 0 |
| installment_frequency | enum `WEEKLY \| MONTHLY \| CUSTOM` | MONTHLY | label only |
| installment_interval_days | int | 30 | actual spacing used |
| created_by | FK User null | | |

**SaleItem (T)**: `sale FK (cascade)`, `item FK (protect)`, `quantity int`,
`unit_price decimal` (after seasonal discount), `line_total decimal`,
`fifo_cost decimal` (= weighted average **unit** cost of consumed lots).

**Installment (T)**: `sale FK (cascade)`, `number int` (1..N, unique per sale),
`due_date date`, `amount decimal` (principal), `paid_amount decimal 0`,
`is_paid bool false`, `paid_date date null`, `interest_charged decimal 0`.
Fully settled when `paid_amount >= amount + interest_charged`.

**Payment (T)** — money in.
`sale FK null (cascade)`, `installment FK null (cascade)`, `amount decimal`,
`method enum CASH|CARD|TRANSFER (CASH)`, `cash_account FK null (set null)`,
`received_by FK User null`, `note text`, `created_at`.

### 4.8 Discounts

**SeasonalDiscount (T)**: `name str(200)`, `scope enum ALL|CATEGORY|BRAND|ITEM`,
`target_id uint null` (id of category/brand/item; ignored for ALL),
`discount_percentage decimal(5,2)`, `start_date date`, `end_date date` (inclusive),
`is_active bool`.

**Promotion (T)** and **Report (T)** tables exist in the schema but have **no API
and no logic** — legacy/unused. A rewrite may drop them.

### 4.9 Suppliers & purchasing

**Supplier (T)**: `name`, `contact_person`, `phone`, `email`, `address`, `is_active`.

**Purchase (T)** (purchase order): `branch FK (protect)` (receiving branch),
`supplier FK (protect)`, `order_no str(50) globally unique` (`PO-<year>-<seq4>`),
`status enum DRAFT|ORDERED|PARTIALLY_RECEIVED|RECEIVED|CANCELLED (DRAFT)`,
`expected_delivery_date date null`, `purchase_date date null` (set for back-dated stock in;
reports use it, else `created_at`), `notes text`, `ordered_by FK User null`.

**PurchaseItem (T)**: `purchase FK (cascade)`, `item FK (protect)`, `quantity int`,
`received_quantity int 0`, `unit_cost decimal`, `total decimal` (= qty × unit_cost).

**PurchaseReceipt (T)**: `purchase FK (cascade)`, `receipt_no str(50) globally unique`
(`RCP-<year>-<seq4>`), `received_by FK User null`, `note text`, `created_at`.

**PurchaseReceiptItem (T)**: `receipt FK (cascade)`, `purchase_item FK (cascade)`, `quantity int`.

### 4.10 Bookkeeping

**CashAccount (T)**: `name`, `type enum CASH|BANK`, `opening_balance decimal(14,2)`, `is_active`.
**ExpenseCategory (T)**: `name`, `is_active`.
**Expense (T)**: `branch FK null`, `category FK (protect)`, `description str(200)`,
`amount decimal(12,2)`, `expense_date date`, `cash_account FK null`, `paid_by FK User null`, `note`.
**SupplierPayment (T)**: `supplier FK (cascade)`, `purchase FK null (set null)`,
`amount`, `payment_date date`, `cash_account FK null`, `paid_by FK User null`, `note`.
**CapitalEntry (T)**: `date`, `type enum OWNER_IN|OWNER_OUT`, `amount decimal(14,2)`, `note`.
**RecurringExpense (T)**: `branch FK null`, `category FK (protect)`, `description`,
`amount`, `frequency enum MONTHLY|WEEKLY|CUSTOM`, `interval_days int 30`,
`next_due_date date`, `is_active`. Used **only for the cash-flow forecast**; nothing
auto-posts expenses from it.

### 4.11 Entity relationships (summary)

```
Business 1─* Branch, User, Category, Brand, Item, Customer, Supplier, Sale, Purchase,
             CashAccount, ExpenseCategory, Expense, SupplierPayment, CapitalEntry,
             RecurringExpense, SeasonalDiscount, StockLot, StockMovement
Category 1─* Category (parent)          Item *─1 Category, Brand
Item 1─* StockLot (per Branch) 1─* LotAllocation *─1 SaleItem
Sale 1─* SaleItem, Installment, Payment     Installment 1─* Payment
Purchase 1─* PurchaseItem 1─* PurchaseReceiptItem *─1 PurchaseReceipt *─1 Purchase
Supplier 1─* Purchase, SupplierPayment     CashAccount 1─* Payment, Expense, SupplierPayment
```

---

## 5. Business rules and calculations

All money math uses decimal arithmetic; "round" = round half-even to 0.01 (Python
`quantize`). Every mutating operation below must run in **one DB transaction**.

### 5.1 Document numbering

```
next_number(prefix, table, field):
    base = f"{prefix}-{current_year}-"              # INV / PO / RCP
    last = row in table with field starting with base, ordered by field DESC (string)
    seq  = last ? int(last.field after last '-') + 1 : 1
    return base + zero_pad(seq, 4)                  # INV-2026-0001
```
Numbers are **global across all businesses** (field is globally unique). The "last"
row is found by ordering on (length DESC, value DESC) so `…-10000` follows `…-9999`;
the insert runs in a savepoint and is retried with a fresh number on a unique clash.

### 5.2 Seasonal discount resolution (per item)

```
rows = SeasonalDiscount where business = B and is_active
       and start_date <= today <= end_date   ORDER BY id ASC
for d in rows:                                   # first match wins
    if d.scope == ALL                               -> return d.discount_percentage
    if d.scope == CATEGORY and d.target_id == item.category_id -> return %
    if d.scope == BRAND    and d.target_id == item.brand_id    -> return %
    if d.scope == ITEM     and d.target_id == item.id          -> return %
return 0
effective_price = percent ? round(selling_price * (1 - percent/100)) : selling_price
```
(Category match is exact — child categories do **not** inherit the parent's discount.)

### 5.3 Recording a sale

Input: branch, optional customer, lines `[{item, quantity>=1}]` (non-empty),
`discount_type` (default PERCENT), `discount_value` (default 0), optional `tax_rate`
(null/absent → business.tax_rate), `is_single_payment` (default true),
`down_payment`, `number_of_installments`, `installment_frequency`,
`installment_interval_days` (default 30), optional `cash_account`, optional
`sale_date` and per-line `unit_price`.

Minimum down payment (installment sales): `min = ceil(total_cost × percent / 10000) × 100`.
400 if `down_payment < min`, or if `min >= total_cost` (order too small for installments).
Applies to back-dated sales too, using the current percentage.

Back-dated sale (`sale_date` before today, manager+, limit §5.14): FIFO uses only lots
received on or before that date; seasonal discounts are those of that date; a given
`unit_price` replaces price and discount (rejected on a sale dated today); the first
due date and invoice year follow the sale date; `Sale.created_at` and the till
`Payment.created_at` are set to its local midnight. The movement keeps its real entry
time and notes the back-date. Earlier sales are never re-costed.

Validation before anything is written:
* `number_of_installments <= business.max_installments` when installment sale and
  the max is set → 400 `{"number_of_installments": "Cannot exceed maximum installments of N ..."}`.
* `discount_value >= 0` and, for PERCENT, `<= 100`; `tax_rate` 0–100; `down_payment >= 0`;
  `installment_interval_days` 1–366.
* **Cashier cap:** when the caller is a cashier, `discount_amount` may not exceed
  `subtotal × business.cashier_discount_cap / 100` (PERCENT and AMOUNT alike) →
  400 `{"detail": "Discount exceeds the cashier limit of 20.00%. Ask a manager to apply it."}`.
* Rule violations inside the service (insufficient stock, down payment ≥ total, 0
  installments) → 400 `{"detail": msg}`; nothing is written (one transaction).

Algorithm:
```
subtotal = 0
for line in lines:
    unit_price = effective_price(item)                 # §5.2
    line_total = unit_price * qty
    subtotal  += line_total
    allocations, avg_unit_cost, ok = allocate_fifo(item, qty, sale.branch)   # §5.6
    if not ok: error "Insufficient stock for <code> at <branch>."
subtotal = round(subtotal)

discount_amount = PERCENT ? round(subtotal * discount_value / 100)
                          : round(min(discount_value, subtotal))
taxable   = subtotal - discount_amount
tax_amount = round(taxable * tax_rate / 100)
total     = round(taxable + tax_amount)

create Sale(... total_cost = total, remaining_cost = total, status OPEN,
            invoice_no = next_number('INV'))
for each line:
    create SaleItem(unit_price, line_total, fifo_cost = avg_unit_cost)
    for (lot, q) in allocations:
        create LotAllocation(lot, sale_item, q, lot.unit_cost)
        lot.quantity_remaining -= q
    item.stock_quantity -= qty
    create StockMovement(type SALE, quantity = -qty, reference = invoice_no, branch = sale branch)

if single payment:
    down_payment = total; remaining_cost = 0; status = CLOSED
    create Payment(amount = total, method CASH, cash_account)
else:
    if down_payment >= total: error "Down payment must be lower than total cost."
    if number_of_installments <= 0: error "Installment sales need a positive installment count."
    remaining_cost = round(total - down_payment)
    create_installments(remaining_cost, N, first_due = today, interval_days)   # §5.4
    if down_payment > 0: create Payment(amount = down_payment, method CASH, cash_account)
```
Response: 201 with full sale detail (§6.6).

### 5.4 Installment schedule

```
create_installments(remaining, count, first_due, interval_days):
    base  = round_down(remaining / count)                # never overshoots
    sizes = [base] * count
    leftover_cents = (remaining - sum(sizes)) * 100      # always >= 0
    for i in 0..count-1 while leftover_cents > 0:
        sizes[i] += 0.01; leftover_cents -= 1
    installment i (1-based) : amount = sizes[i-1],
                              due_date = first_due + interval_days * i
```
Example: 10 000.00 over 3 → 3333.34, 3333.33, 3333.33; due today+30, +60, +90.

**Monthly interest** (`installment_monthly_interest_rate > 0`):
`balance = total_cost − down_payment`; `months = count` for MONTHLY, else
`count × interval_days / 30`; every installment =
`ceil(balance × (1 + rate% × months) / count / 50) × 50`.
`Sale.monthly_interest_rate` and `Sale.plan_interest = Σ installments − balance` are
stored; `remaining_cost` starts at Σ installments; `total_cost` stays the goods total
(no VAT on interest). Reports count `plan_interest` as interest income on the sale date.

**Customer and guarantors:** an installment sale requires `customer` and exactly
`required_guarantors` ids in `guarantors` (own business, distinct, not the buyer),
stored as `Sale.guarantor_1/2` (protected from deletion). A customer with an OPEN sale
cannot be deleted. `installment_interest_rate` is the **Delay payment rate** in the SPA
(the one-time short-payment charge of §5.5).

### 5.5 Paying an installment

Input: sale (URL), `installment` id (must belong to that sale and business),
`amount >= 0.01`, `method` (CASH default), optional `cash_account`, optional
`payment_date` (manager+, limit §5.14, not before the sale date; sets
`Payment.created_at` and `paid_date`).

```
lock sale + its installments (SELECT … FOR UPDATE)
if amount <= 0:                     error "Payment amount must be positive."
if sale.status == CANCELLED:        error "This sale is cancelled; payments cannot be recorded."
if selected fully settled:          error "Installment already fully paid."
if amount > sale.remaining_cost:    error "Payment exceeds balance due."

remaining = amount
order = [selected] + other installments ORDER BY number   # earlier ones included
for inst in order:
    due = inst.amount + inst.interest_charged - inst.paid_amount
    if due <= 0: continue
    take = min(due, remaining)
    inst.paid_amount += take; remaining -= take
    if inst.paid_amount >= inst.amount + inst.interest_charged:
        inst.is_paid = true; inst.paid_date = today
    if remaining <= 0: break

# one-time late interest: SELECTED installment, only if never charged before
shortfall = selected.amount - selected.paid_amount
interest = 0
if shortfall > 0 and rate > 0 and selected.interest_charged == 0:
    interest = round(shortfall * rate / 100)
    selected.interest_charged += interest

create ONE Payment(sale, installment = selected, amount, method, cash_account)
sale.remaining_cost = sale.remaining_cost - amount + interest
if sale.remaining_cost <= 0: remaining_cost = 0; status = CLOSED
```
Responses: 200 with refreshed sale detail; 400 `{"detail": msg}`; 404
`{"detail": "Installment not found on this sale."}`.

Worked examples (tests `test_overpayment_rolls_forward`, `test_underpayment_charges_one_time_interest`):
* 3 × 1000, pay 1500 on #1 → #1 paid 1000 (settled), #2 paid 500.
* 3 × 1000, #1 unpaid, pay 2500 on #3 → #3 1000, #1 1000, #2 500 (nothing is lost).
* rate 10 %, pay 600 on a 1000 installment → shortfall 400 → interest 40; installment
  now owes 1000 + 40 − 600 = 440; sale remaining += 40 − 600.

### 5.6 FIFO allocation

```
allocate_fifo(item, qty):
    lots = StockLot where business = B and item = item and branch = sale branch
           and quantity_remaining > 0  ORDER BY received_at, id   FOR UPDATE
    take from oldest lots until qty satisfied
    if not enough: return fail
    avg_unit_cost = round(Σ(take * lot.unit_cost) / qty)
```
Because the average is rounded to cents, `fifo_cost × qty` can differ from the exact lot
total by a few cents (e.g. 5×100 + 2×120 = 740 is reported as 105.71×7 = 739.97).
COGS of a sale line = `fifo_cost × quantity`.

### 5.7 Stock-in paths

| Path | Effect |
|---|---|
| **Stock in** `POST /stock-ins/`, `source=PURCHASE` | a purchase order is created and fully received (so payables stay right), optional `SupplierPayment` |
| **Stock in**, `source=OPENING` | lot `OPENING`, `stock_quantity += q`, movement IN; no payable (the balance sheet needs a matching capital entry) |
| **Item create with opening stock** (API only; the SPA no longer uses it) (`opening_stock>=1`, `opening_branch` required, `opening_unit_cost` default `cost_price`) | lot `OPENING` (ref 'OPENING'), `stock_quantity = opening_stock`, movement IN |
| **PO receive** (§5.8) | lot `PURCHASE` per line at `PurchaseItem.unit_cost`, branch = PO branch, ref = receipt no; `stock_quantity += q`; movement IN |
| **Manual adjust** `POST /items/{id}/adjust/ {quantity≠0, branch (required, own business), note}` | qty > 0: lot `ADJUSTMENT` at `unit_cost` (optional, ≥0) or `item.cost_price`; qty < 0: units are removed FIFO from that branch's lots; 400 if the branch has fewer units; `stock_quantity += qty`; movement ADJUST (ref `ADJ <code>`) |
| `Item.stock_quantity` | read-only in the API — changes only through the paths in this table |
| **Sale cancel** (§5.9) | lot quantities restored; `stock_quantity += qty`; movement ADJUST (+qty) |

Stock in may update `Item.selling_price` (one price per item, not per lot). A past
`received_date` sets `StockLot.received_at` (so FIFO order follows arrival), the order's
`purchase_date` and the paid-now `payment_date`.

### 5.8 Purchase order lifecycle

```
create  (manager+): {supplier, branch, expected_delivery_date?, notes?}
         → status DRAFT, order_no = next_number('PO'), ordered_by = user
add_item: {item, quantity>=1, unit_cost} allowed unless status RECEIVED;
         total = quantity * unit_cost
remove_item: {item_id} only lines with received_quantity = 0
place:   DRAFT → ORDERED (requires ≥1 line)
cancel:  allowed unless RECEIVED / PARTIALLY_RECEIVED → CANCELLED
receive: {quantities?: {"<purchase_item_id>": qty}, note?}
         only when status is ORDERED or PARTIALLY_RECEIVED (else 400)
         for each line: q = min(quantities.get(id, outstanding), outstanding); skip q <= 0
         if nothing to receive → 400 "No outstanding line quantities to receive."
         create PurchaseReceipt (RCP-…), receipt items, lots, movements
         status = all lines fully received ? RECEIVED : PARTIALLY_RECEIVED
         → 201 receipt JSON
```
add_item is refused on RECEIVED/CANCELLED orders; DELETE only on DRAFT orders.

### 5.9 Sale cancellation (manager / business_admin)

```
if status == CANCELLED: 400 "Sale is already cancelled."
for each sale item:
    for each allocation: lot.quantity_remaining += allocation.quantity
    item.stock_quantity += quantity
    StockMovement(ADJUST, +quantity, ref invoice_no, note "Cancelled sale <inv>")
status = CANCELLED; remaining_cost = 0
```
Runs in one transaction with the sale row locked. Payments already received are
**not** refunded (no refund workflow yet); the cancelled sale's installments are
excluded from due lists, the dashboard and the cash-flow forecast, and further
payments are refused.

### 5.10 Supplier ledger / payables

```
for each purchase of supplier with status not in (DRAFT, CANCELLED):
    line_total   = Σ PurchaseItem.total
    received_value = Σ (line.received_quantity × line.unit_cost)
total_billed = Σ received_value;  total_paid = Σ SupplierPayment.amount
balance = total_billed - total_paid
```

### 5.11 Cash account balance

```
balance(acct) = opening_balance
              + Σ Payment.amount        where cash_account = acct
              − Σ Expense.amount        where cash_account = acct
              − Σ SupplierPayment.amount where cash_account = acct
```
Capital entries are **not** included; payments recorded without a cash account are
not counted anywhere.

### 5.12 Limits

* Branch create: reject when `count(branches) >= max_branches` → 400 `{"detail": "Branch limit reached (N). Ask the platform owner to increase it."}`.
* User create (business admin or super admin) / moving a user into a business:
  reject when `count(users) >= max_users` → 400 `{"detail": "This business has reached its user limit (N). ..."}`.
* Creating a business auto-creates branch **"Main Branch"** (copying address/phone).

* Category / brand / item create: same rule with `max_categories`, `max_brands`, `max_items`
  (inactive items count). Lowering a limit never removes existing rows.
* The SPA calls items **"Products"** in all visible text; the API, database and routes keep `item`.

### 5.13 Field visibility

* Cashier: `cost_price` removed from item payloads (and `next_cost`, `stock_value` from
  `branch_stock`); `fifo_cost` removed from sale lines.

### 5.14 Back-dating

One rule for `received_date`, `sale_date` and `payment_date`: omitted or today = now;
future → 400; past requires manager+ and `Business.backdate_limit_days` (0 → 400;
N → no earlier than today − N; null → any). Changing the limit does not touch
existing records. Supplier payment and expense dates are not covered by this limit.

---

## 6. API contract

Base: `https://api.nivora.lk/api`. All endpoints require `Authorization: Bearer <access>`
except health, login, refresh. Trailing slashes are required. "CRUD" =
`GET list`, `POST create`, `GET /{id}/`, `PUT /{id}/`, `PATCH /{id}/`, `DELETE /{id}/`.

### 6.1 Auth

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health/` | — | `200 {"status":"ok"}` (no auth, no DB) |
| POST | `/auth/login/` | `{username, password}` | `200 {access, refresh, user:<User>}`; 400 `{"non_field_errors":["Invalid credentials or inactive account."]}` |
| POST | `/auth/refresh/` | `{refresh}` | `200 {access}` |
| GET | `/auth/me/` | — | `<User>` |

`<User>` = `{id, username, full_name, phone, role, business, branch, is_active, email,
business_tax_rate:"15.00", business_installment_interest_rate:"0.00", business_backdate_limit_days:0, business_item_images_enabled:true, business_min_down_payment_percent:"0.00", business_installments_enabled:true,
business_installment_monthly_interest_rate:"0.00", business_required_guarantors:0,
business_name, business_logo:"/media/business_logos/x.png"|null}`
(`business_tax_rate` etc. are `"0"`/null when user has no business).

### 6.2 Branches, catalog

| Path | Roles | Notes |
|---|---|---|
| `/branches/` CRUD | read all staff; write business_admin | fields `id,name,address,phone,is_active,created_at`; search `q` on name/phone/address; create enforces `max_branches` |
| `/categories/` CRUD | read staff; write manager+ | `id,name,parent,created_at`; search name |
| `/brands/` CRUD | read staff; write manager+ | `id,name,created_at` |
| `/items/` CRUD | read staff; write manager+ | see below |
| `POST /items/{id}/adjust/` | manager+ | `{quantity:int≠0, branch:id, note?, unit_cost?}` → `{item_id, new_stock}` |

`branch_stock` rows are `{branch_id,branch_name,quantity,next_cost*,stock_value*}`
(`next_cost` = unit cost of the oldest open lot there; `*` hidden from cashiers).
`GET /items/?price_date=YYYY-MM-DD` computes `effective_price` / `discount_percent`
for that date (used by back-dated sales).

Item list/detail JSON:
```json
{ "id":1, "code":"TV-55", "name":"55in TV", "category":3, "category_name":"TV",
  "brand":2, "brand_name":"LG", "cost_price":"90000.00", "selling_price":"120000.00",
  "stock_quantity":7, "low_stock_threshold":5, "is_active":true, "image":null,
  "branch_stock":[{"branch_id":1,"branch_name":"Main Branch","quantity":7}],
  "effective_price":"108000.00", "discount_percent":"10.00",
  "created_at":"…", "updated_at":"…" }            // timestamps on detail only
```
Item filters: `category`, `brand`, `is_active`, `low_stock_threshold`,
`low_stock=true`, `q` (code/name), ordering `code,name,cost_price,selling_price,stock_quantity`.
Create extra write-only fields: `opening_stock`, `opening_branch`, `opening_unit_cost`.
Duplicate code in same business → 400 `{"code": "An item with this code already exists in this business."}`.
Delete with sale/purchase history → 400 `{"detail":"This item has sale or purchase history and cannot be deleted. Deactivate it instead."}`.

### 6.3 Customers

`/customers/` CRUD (all staff). Fields `id,name,phone,nic,address,id_card_photo,created_at`.
Photo upload uses multipart/form-data. Search `q` on name/phone/nic.

`GET /customers/{id}/history/` →
```json
{ "customer":{…}, "total_sales_count":3, "total_spent":"…",
  "outstanding":"…", "sales":[<SaleList> × ≤20, newest first] }
```
(excludes cancelled sales; outstanding = Σ remaining_cost of OPEN sales).

### 6.4 Suppliers & purchases (manager+)

* `/suppliers/` CRUD — `id,name,contact_person,phone,email,address,is_active,created_at`.
* `GET /suppliers/{id}/ledger/` →
  `{supplier, purchase_count, total_billed, total_paid, balance,
    purchases:[{id,order_no,status,expected_delivery_date,purchase_date,total,received_value,created_at}],
    payments:[<SupplierPayment>]}`.
* `/purchases/` list → `{id,order_no,supplier,supplier_name,status,expected_delivery_date,purchase_date,total,created_at}`;
  detail adds `notes, items:[{id,item,item_code,item_name,quantity,received_quantity,unit_cost,total}],
  receipts:[{id,receipt_no,note,received_by,items:[{id,purchase_item,item_code,quantity}],created_at}]`.
  Filters `status,supplier,branch`; search order_no / supplier name.
* `POST /purchases/` `{supplier, branch, expected_delivery_date?, notes?}` → 201 detail.
* `POST /purchases/{id}/add_item/` `{item, quantity, unit_cost}` → 201 detail.
* `POST /purchases/{id}/remove_item/` `{item_id}` → 200 detail / 400.
* `POST /purchases/{id}/place/` → 200 detail / 400.
* `POST /purchases/{id}/cancel/` → 200 detail / 400.
* `POST /purchases/{id}/receive/` `{quantities?:{"<purchase_item_id>":qty}, note?}` → 201 receipt / 400.
* `/supplier-payments/` CRUD — `id,supplier,supplier_name,purchase,amount,payment_date,cash_account,paid_by,note,created_at`;
  filters `supplier,purchase,cash_account,payment_date`.

### 6.5 Stock (manager+)

* `POST /stock-ins/` `{source: PURCHASE|OPENING, branch, supplier (PURCHASE only),
  lines:[{item, quantity>=1, unit_cost>=0, selling_price?}], paid_amount?, cash_account?
  (required if paid), received_date?, note?}` → 201
  `{source,purchase,order_no,receipt_no,line_count,total_cost}`; all-or-nothing.

* `GET /stock-lots/` — `id,item,item_code,item_name,branch,quantity_total,quantity_remaining,unit_cost,source,reference,received_at`;
  filters `item,branch,source,item__category`; ordering `received_at,quantity_remaining`.
* `GET /stock-movements/` — `id,item,item_code,branch,type,quantity,reference,note,created_by,created_at`;
  filters `item,branch,type`.
* Both are read-only (`GET` only).

### 6.6 Sales & payments

`GET /sales/` (all staff) → `<SaleList>`:
```
id, invoice_no, branch, branch_name, customer, customer_name, customer_phone,
customer_address, subtotal, discount_amount, tax_amount, tax_rate, total_cost,
down_payment, remaining_cost, status, is_single_payment, number_of_installments,
installment_frequency, created_by, created_by_name, created_at, is_fully_paid
```
Filters: `status, branch, customer, is_single_payment, customer_name, customer_phone,
customer_nic, date_from, date_to (YYYY-MM-DD, on created_at local date),
paid_status=fully_paid|outstanding, q (invoice_no, customer name/phone)`;
ordering `created_at, invoice_no`.

`GET /sales/{id}/` → SaleList fields plus:
```
items:[{id,item,item_code,item_name,quantity,unit_price,line_total,fifo_cost*}],
installments:[{id,number,due_date,amount,paid_amount,is_paid,paid_date,interest_charged}],
payments:[{id,sale,installment,installment_number,amount,method,cash_account,
           received_by,note,created_at,cash_account_name,received_by_name}],
business_name, business_address, business_phone, business_logo,
branch_address, branch_phone, discount_label ("10.00%" | "LKR 500.00" | "")
```
(*hidden from cashier)

`POST /sales/` body (§5.3):
```json
{ "branch":1, "customer":5, "lines":[{"item":12,"quantity":2}],
  "discount_type":"PERCENT", "discount_value":"5", "tax_rate":null,
  "is_single_payment":false, "down_payment":"20000", "number_of_installments":6,
  "installment_frequency":"MONTHLY", "installment_interval_days":30, "cash_account":1 }
```
→ 201 sale detail.

`POST /sales/{id}/pay_installment/` `{installment, amount, method?, cash_account?, payment_date?}` → 200 sale detail.
`POST /sales/` also takes `sale_date?`, `lines[].unit_price?` (§5.3) and `guarantors?` (§5.4).
Sale detail adds `monthly_interest_rate`, `plan_interest`, `guarantors[{id,name,phone,nic,address}]`.
`POST /sales/{id}/cancel/` → 200 sale detail (manager+).
`PUT/PATCH/DELETE /sales/{id}/` return 405 — sales are immutable.

`GET /payments/` (read-only) — Payment JSON above; filters `sale,installment,method,cash_account`.

`GET /installments/due/?days=7` (all staff) → **not paginated**:
```json
{ "results":[{ "id","sale","invoice_no","customer","customer_name","customer_phone",
               "due_date","amount","interest_charged","due_amount","is_paid","number" }] }
```
includes overdue (any date ≤ today+days) where not fully settled; ordered due_date, number.

### 6.7 Bookkeeping

| Path | Roles | Fields |
|---|---|---|
| `/cash-accounts/` CRUD | read staff, write business_admin | `id,name,type,opening_balance,balance (derived),is_active,created_at`; filters `type,is_active` |
| `/expense-categories/` CRUD | read manager+, write business_admin | `id,name,is_active` |
| `/expenses/` CRUD | manager+ | `id,branch,branch_name,category,category_name,description,amount,expense_date,cash_account,paid_by,note,created_at`; create body `{branch?,category,description,amount>=0.01,expense_date? (default today),cash_account?}`; filters `branch,category,expense_date,cash_account` |
| `/recurring-expenses/` CRUD | manager+ | `id,branch,category,category_name,description,amount,frequency,interval_days,next_due_date,is_active` |
| `/capital-entries/` CRUD | business_admin | `id,date,type,amount,note,created_at` |
| `/seasonal-discounts/` CRUD | manager+ | `id,name,scope,target_id,discount_percentage,start_date,end_date,is_active,created_at` |
| `GET/PATCH /finance-settings/` | business_admin | `{tax_rate:"15.00", installment_interest_rate:"2.00"}` each 0–100 |
| `GET/POST /business/logo/` | GET any; POST business_admin | POST multipart `logo` (jpeg/png/gif/webp, ≤2 MB; bytes verified with an image decoder, stored extension derived from the detected format) → 201 `{filename,url}`; GET → `{url,filename}` or `{none:true}` |

### 6.8 Users

`/users/` (business_admin, own business only):
* list → paginated User objects plus top-level `max_users`, `seats_used`.
* create `{username, password (≥8), full_name?, phone?, role (business_admin|manager|cashier), branch?, is_active?, email?}`; business is forced; `branch` must be own business; seat limit enforced.
* update/patch: same fields; cannot set foreign business, cannot assign `super_admin`,
  cannot deactivate or change role of yourself. Password optional (reset when present).

`/admin/businesses/` (super_admin) — `GET, POST, PATCH, DELETE`. Fields
`id,name,address,phone,email,logo,is_active,tax_rate,cashier_discount_cap,max_users,max_branches,
backdate_limit_days,max_categories,max_brands,max_items,item_images_enabled,
item_count,category_count,brand_count,branch_count,user_count,created_at,updated_at`.
Create auto-adds "Main Branch".

`/admin/users/` (super_admin) — CRUD on any user; business required for business roles; seat limits enforced.

### 6.9 Reports & dashboard (manager+) — see §7 for formulas

| Path | Params | Response |
|---|---|---|
| `/reports/sales/` | `from,to,branch,group_by=day\|month` | `[{date,invoice_count,subtotal,discount,tax,total,profit}]` |
| `/reports/cash/` | — | `{"<account_id>": "balance"}` |
| `/reports/profit/` = `/reports/profit-loss/` | `from,to` | `{gross_sales,discounts,revenue,cogs,gross_profit,interest_income,expenses,net_profit}` |
| `/reports/balance-sheet/` | `as_of=YYYY-MM-DD` | `{as_of, assets{cash,inventory,receivables,total}, liabilities{supplier_payables,total}, equity{owner_capital,retained_earnings,total}, total_liabilities_and_equity, difference}` |
| `/reports/cash-flow/` | `weeks=1..52 (13)` | `{from_date,to_date,weeks,opening_balance,buckets:[{week_start,inflows,outflows,net,cumulative}],total_inflows,total_outflows,closing_balance}` |
| `/reports/tax/` | `from,to` | `{from_date,to_date,rate,invoice_count,gross_sales,discounts,taxable_sales,tax_collected,purchase_value,payable}` |
| `/reports/stock/` | — | `[{id,code,name,stock_quantity,low_stock_threshold}]` |
| `/dashboard/` | — | `{today_sales,month_sales,outstanding,low_stock_count,expense_month}` |
| `/dashboard/summary/` | — | `{today_sales,low_stock_count,low_stock_items[{id,code,name,stock_quantity}],top_item,due_installments_count,due_installments_list[{id,customer_name,invoice_no,due_amount,due_date}] (≤8),open_sales}` |
| `/dashboard/branch-sales/` | `start,end` | `[{branch,total}]` (non-zero, desc) |

Other routes: `/admin/` (Django admin site), `/api/schema/` (OpenAPI), `/api/docs/` (Swagger UI),
`/media/<path>` (dev fallback file serving).

---

## 7. Reports

All report numbers exclude other businesses. "Valid sales" = status OPEN or CLOSED.

| Report | Definition (as implemented) |
|---|---|
| Sales by period | group valid sales by local day/month of `created_at`: count, Σsubtotal, Σdiscount_amount, Σtax_amount, Σtotal_cost; profit = (Σsubtotal − Σdiscount_amount) − Σ(fifo_cost×qty) (tax excluded). |
| Profit & loss | valid sales in period: gross_sales = Σsubtotal; discounts = Σdiscount_amount; revenue = gross_sales − discounts; cogs = Σ(fifo_cost × qty); gross_profit = revenue − cogs; interest_income = Σ installment interest_charged of those sales; expenses = Σ Expense.amount by `expense_date`; net_profit = gross_profit + interest_income − expenses. |
| Balance sheet | assets: cash = Σ current account balances (not as-of); inventory = Σ(quantity_remaining × unit_cost) of lots created ≤ as_of (current remaining qty); receivables = Σ remaining_cost of OPEN sales. liabilities: supplier payables (§5.10) as of date. equity: capital = Σ OWNER_IN − Σ OWNER_OUT (≤ as_of); retained = (revenue + interest) − cogs (valid sales ≤ as_of) − expenses (expense_date ≤ as_of). Cash and inventory use current balances (not true as-of values). `difference = assets − liabilities − equity` is shown, not forced to 0. |
| Cash-flow forecast | weekly buckets from today; inflows = outstanding (amount + interest − paid) of non-cancelled sales' installments due in the bucket; outflows = each active recurring expense projected forward by `interval_days`; opening = Σ cash balances; cumulative running net. |
| VAT | valid sales in period: gross = Σsubtotal, discounts, taxable = gross − discounts, tax_collected = Σtax_amount, payable = tax_collected; purchase_value (received lines, context only). |
| Low stock | active items with `stock_quantity <= low_stock_threshold`, ascending stock. |

---

## 8. Frontend (React SPA)

Stack: React 18, Vite, React Router, TanStack Query, Axios, Tailwind CSS, Recharts,
html2canvas + jsPDF (PDF bills). Source: `frontend/src/`.

### 8.1 Structure

| Folder | Content |
|---|---|
| `api/client.js` | Axios instance, token storage, 401 → refresh → retry, `apiErrorMessage()` |
| `api/endpoints.js` | one helper object per resource (`salesApi.create`, …) — the client-side API contract |
| `api/queryKeys.js` | TanStack Query cache keys |
| `context/AuthContext.jsx` | login/logout, `/auth/me` profile, `auth:logout` event |
| `routes/index.jsx`, `routes/access.js`, `routes/menu.js` | routes, role guards, sidebar model, landing path per role |
| `components/` | layout (Sidebar, Topbar with connection pill), DataTable, Modal, FormField, PhotoUpload, StatCard, `print/Bills.jsx` |
| `hooks/` | `useConnectionState` (5 s heartbeat, 1.5 s timeout), `useApiMutation`, `useDocumentTitle` |
| `utils/` | `format.js` (LKR/date formatting), `permissions.js` (role groups), `compressImage.js` (client-side photo compression), `downloadBillPdf.js` |
| `pages/` | one file per screen (below) |

### 8.2 Routes and screens

Role groups: `STAFF` = business_admin, manager, cashier; `ADMIN_MANAGER` = business_admin, manager;
`BUSINESS_ADMINS`; `SUPER_ADMINS`; `DASHBOARD_VIEWERS` = super_admin, business_admin, manager.

| Route | Roles | Screen / behaviour | APIs |
|---|---|---|---|
| `/login` | public | username/password; redirects to role landing | auth |
| `/dashboard` | DASHBOARD_VIEWERS | stat cards, low stock, due installments, branch sales chart | dashboard/summary, branch-sales |
| `/sales/new` | STAFF | POS: branch select, customer select (walk-in default), item search (shows per-branch stock + seasonal % off), cart, spot discount, tax (pre-filled from `business_tax_rate`), single vs installment (down payment, count, frequency, interval), cash account | branches, customers, cash-accounts, items, sales.create |
| `/sales` | STAFF | sales list with filters (customer, phone, NIC, dates, paid status, branch) | sales.list |
| `/sales/:id` | STAFF | sale detail, installments table, pay installment, cancel (manager+), **print / PDF bill** | sales.get/pay/cancel, cash-accounts |
| `/installments` | STAFF | due & overdue list, quick pay | installments/due, payInstallment |
| `/installments/pay` | STAFF | find outstanding sale → pay an installment | sales.list/get, payInstallment |
| `/customers` | STAFF | CRUD, ID photo upload, purchase history drawer | customers.* |
| `/items` | STAFF (write manager+) | product CRUD (no quantities or cost), per-branch stock, last cost, next FIFO cost and stock value (hidden for cashier) | items, categories, brands |
| `/stock/in` | ADMIN_MANAGER | supplier purchase or opening stock in one step, optional price change, payment and received date | stock-ins, items, suppliers, branches, cash-accounts |
| `/categories`, `/brands` | ADMIN_MANAGER | CRUD | |
| `/stock/purchases` | ADMIN_MANAGER | PO create, lines add/remove, place, cancel, receive | purchases.*, suppliers, items, branches |
| `/stock/receive` | ADMIN_MANAGER | receive deliveries against ordered POs (partial quantities) | purchases.receive |
| `/stock/lots` | ADMIN_MANAGER | FIFO lot registry | stock-lots |
| `/stock/movements` | ADMIN_MANAGER | movement audit trail | stock-movements |
| `/suppliers` | ADMIN_MANAGER | supplier CRUD | suppliers |
| `/expenses` | ADMIN_MANAGER | expense CRUD | expenses, expense-categories (read), cash-accounts, branches |
| `/expenses/recurring` | ADMIN_MANAGER | recurring expense CRUD | recurring-expenses |
| `/promotions` | ADMIN_MANAGER | seasonal discount CRUD (scope ALL/CATEGORY/BRAND/ITEM) | seasonal-discounts |
| `/reports` | ADMIN_MANAGER | tabs: P&L, balance sheet, cash-flow, VAT | reports.* |
| `/settings/finance` | BUSINESS_ADMINS | tax & interest rate, cash accounts CRUD, capital entries CRUD | finance-settings, cash-accounts, capital-entries |
| `/settings/manage-business` | BUSINESS_ADMINS | logo upload, finance constants | business/logo, finance-settings |
| `/users` | BUSINESS_ADMINS | staff CRUD with seat counter | users |
| `/branches` | BUSINESS_ADMINS | branch CRUD | branches |
| `/admin/businesses` | SUPER_ADMINS | business CRUD incl. limits, discount cap, counts | admin/businesses |
| `/admin/users` | SUPER_ADMINS | any-user CRUD | admin/users |

Not exposed in the UI although the API exists: expense-category create, supplier
payments, supplier ledger, stock adjustment, payments registry, sales/stock reports
(`/reports/sales`, `/reports/stock`), `/dashboard/`.

### 8.3 Printing rules (`components/print/Bills.jsx`)

* Header: business logo/name/address/phone + branch address/phone.
* **Single-payment sale**: one A4 **invoice** marked "Paid in full".
* **Installment sale**: invoice + payment **receipt** (installment schedule and payments).
* Print uses the browser print dialog; "Download PDF" renders via html2canvas → jsPDF.

### 8.4 Connection state

`useConnectionState` probes `GET {API}/health/` (raw fetch, no auth) at boot, every 5 s,
and on browser `online` events; 1.5 s timeout → `checking | online | offline`.
Displayed as a pill in the Topbar. No offline queueing exists yet.

---

## 9. Platform admin and bootstrap flow

1. Run migrations; create a super admin: `manage.py createsuperuser` (prompts for `role` → `super_admin`).
2. Super admin creates a **Business** (SPA `/admin/businesses` or Django `/admin/`) →
   "Main Branch" is created automatically.
3. Super admin creates the first **business_admin** user for that business (`/admin/users`).
4. Business admin logs into the SPA: sets tax/interest rate, cash accounts, branches,
   staff, then catalog → opening stock / purchase orders → sales.
5. Demo data: `manage.py seed_demo` creates a demo business with sample data.

Expense categories currently can only be created through Django `/admin/` (super
admin) or the API — no SPA screen (§12 G-01).

---

## 10. Deployment notes

* Full runbook: `docs/deploy-cpanel.md`; terminal sheet: `deploy/terminal-commands.txt`.
* Current production layout (nivora.lk): SPA in `~/public_html/system.nivora.lk/`;
  backend cloned by cPanel Git into `~/repositories/nivora-system/backend` and run by
  **Setup Python App** (Python 3.12, domain `api.nivora.lk`); MySQL `nivoralk_shopapi`
  via PyMySQL (`DB_DRIVER=pymysql`, mysqlclient cannot compile on the host).
* **Lesson (2026-11-24):** the host runs LiteSpeed; Python apps need the
  `lswsgi` binary (`/opt/alt/python3XX/bin/lswsgi`). It was missing for every Python
  version → permanent 503 with `lswsgi_wrapper: ... No such file or directory` in
  `stderr.log`. Only the host can install it. Diagnose 503s by reading
  `<app root>/stderr.log` first.
* Rewriting the backend in PHP (Laravel) removes the Python-runtime dependency on
  shared hosting; the SPA can stay unchanged if the API in §6 is reproduced exactly.

---

## 11. Rewrite guide

### 11.1 Recommended build order

1. Schema (§4) with all uniqueness/foreign-key rules; money as DECIMAL, never float.
2. Auth: JWT login/refresh/me with the exact JSON (§6.1); role guard middleware;
   tenant scoping helper that injects `business_id` into every query and validates
   every incoming FK against the tenant.
3. Simple CRUD: branches, categories, brands, customers, suppliers, cash accounts,
   expense categories, capital, recurring expenses, seasonal discounts (paginated
   `{count,next,previous,results}`, `q` search, `page_size`).
4. Items + opening stock + FIFO lots + adjust.
5. Sales service (§5.2–5.6) in a single transaction with **row locks** on lots/items.
6. Installment payment service (§5.5), cancel (§5.9).
7. Purchasing (§5.8) and supplier ledger (§5.10).
8. Expenses, cash balances (§5.11).
9. Reports & dashboard (§7, §6.9).
10. Users / admin endpoints with limits (§5.12, §6.8), logo upload.
11. Point the existing SPA (`VITE_API_URL`) at the new API and run the acceptance list.

### 11.2 Invariants that must always hold

* `Item.stock_quantity == Σ StockLot.quantity_remaining` for that item (all branches).
* `Σ LotAllocation.quantity` of a sale line `== SaleItem.quantity`.
* Installment sale: `Σ Installment.amount == total_cost − down_payment` at creation.
* `Sale.remaining_cost == Σ (amount + interest_charged − paid_amount)` over its installments.
* `Sale.remaining_cost >= 0`; `StockLot.quantity_remaining >= 0`.
* No row of business A is ever readable/writable or referenceable by business B.
* Cashier responses never contain `cost_price`, `fifo_cost`, `next_cost` or `stock_value`.

### 11.3 Acceptance checklist (mirrors `backend/core/tests.py`, 200 tests)

Test status 2026-11-24 (after the bug-fix batch): `python manage.py test core` →
**200 passed, 0 failed** (SQLite, ~230 s).

Tenant isolation (items, users, ledger, due installments, finance settings) ·
login/refresh/me · health anonymous & DB-free · logo upload rules · sale math
(single, percent discount, tax default from business) · FIFO cost & stock decrement ·
insufficient stock · installment split & rounding · payment roll-forward ·
one-time interest (zero rate, exact payment, must repay interest to close) ·
overpayment rejected · due-installments view (days, partial, paid excluded) ·
PO add/receive full/partial · role permissions (cashier vs manager vs admin) ·
item code uniqueness per business · foreign category/brand/branch rejected ·
opening stock · protected delete · business create → Main Branch · user/branch
limits · stock adjust · dashboard summary & branch sales · cost hiding for cashier ·
customer history · sale cancel restores lots · expense FK isolation · business-user
guardrails (no super_admin, no self-demote/deactivate) · supplier ledger · reports
shapes · sales list filters (customer name/phone/NIC, dates, paid status).

---

## 12. Known bugs and gaps

Severity: **Critical** (security / data loss) · **High** (wrong money or stock, cross-tenant) ·
**Medium** (wrong numbers in edge cases, broken flows) · **Low** (minor / cosmetic).
**Fixed on 2026-11-24** (with regression tests in `core/tests.py`:
`SecurityHardeningTests`, `MoneyAndStockFixTests`, `BusinessLogoTests`):
B-01, B-02, B-03, B-04, B-05, B-06, B-07, B-08, B-09, B-10, B-11, B-12, B-13, B-14,
B-15, B-16, B-17, B-18, B-19, B-21. Also fixed 2026-11-24 (second batch): B-20 (POS
customer search, server-side `q`), B-22 (`account_balances` = 3 grouped queries, cached per
request; `CashAccountListPerformanceTests`), B-23 (super admin removed from
`DASHBOARD_VIEWERS`), B-25 (health probe: 30 s interval, 8 s timeout, paused in hidden tabs,
2 consecutive failures before "Offline"). The rules in §5–§7 describe the fixed behaviour;
the table below keeps the original description for history.
Third batch (2026-11-24): B-24 fixed — ID-card photos are stored under `PRIVATE_MEDIA_ROOT`
(outside the web root; migration 0006 moves existing files) and served only by
`GET /api/customers/{id}/id-card-photo/?sig=…` (signed, bound to customer + file, expires after
`PRIVATE_MEDIA_URL_MAX_AGE`, default 3600 s); `CustomerSerializer.id_card_photo` now returns that
signed URL. G-01 closed (`/expenses/categories` screen). G-02 partly closed: `/suppliers/payments`
(supplier payments + ledger) and the "Adjust Stock" dialog on `/stock/movements`; the payments
registry and `/reports/sales`, `/reports/stock` screens are still missing. Deleting a row that is
still referenced (on_delete=PROTECT) now returns 400 for every tenant endpoint.
Mobile: modals scroll instead of clipping their top; tables keep one line per cell on phones.
**Still open:** G-02 (remaining screens), G-03…G-07.

### Bugs

| ID | Sev | Where | Problem | Failure scenario |
|---|---|---|---|---|
| B-01 | **Critical** | `backend/core/views/business_logo.py:36-50` | Logo upload trusts the client `Content-Type` and keeps the **original file extension**. Files land in the web-served `public_html/system.nivora.lk/media/`. | A business admin (or stolen admin token) uploads `shell.php` with header `image/png` → stored as `media/business_logos/<rand>.php` → executed by LiteSpeed/PHP = remote code execution on the hosting account; or `x.html` → stored XSS on the SPA origin that can read JWTs from localStorage. Fix: validate with Pillow, force extension from detected format, deny script execution in `media/` via `.htaccess`. |
| B-02 | **High** | `serializers.py` (`CategorySerializer`, `PurchaseCreateSerializer`, `SupplierPaymentSerializer`, `RecurringExpenseSerializer`, `ExpenseSerializer` (update), `StockLot/StockMovementSerializer`), `views/suppliers.py:156` | Foreign-key fields are not restricted to the caller's business (querysets default to *all rows*). `PurchaseCreateSerializer` is even instantiated without request context. | Manager of shop A posts `{"supplier": <B's supplier id>, "branch": <B's branch id>}` to `/purchases/` → PO created; receiving it creates stock lots in shop B's branch. Similar: supplier payment against B's supplier/cash account (B's cash balance changes), category with B's parent, expense edited to B's cash account. Response echoes B's names (data leak). |
| B-03 | **High** | `views/stock.py` | Stock lots / movements are documented read-only but extend a full `ModelViewSet` → `POST/PUT/PATCH/DELETE` work for managers. | Manager PATCHes a lot's `quantity_remaining` or deletes lots → FIFO costs and stock silently corrupted with no audit; combined with B-02 can create lots referencing other tenants' items/branches. Fix: `http_method_names = ['get']`. |
| B-04 | **High** | `backend/shopapi/settings.py:143` | Setting is named `SIMPLEJWT`; the library reads `SIMPLE_JWT`. `JWT_ACCESS_MINUTES`/`JWT_REFRESH_DAYS` are ignored → library defaults: access **5 min**, refresh **1 day**. | Every user is logged out after 24 h regardless of activity; access tokens refresh every 5 min (extra load); configured lifetimes have no effect. |
| B-05 | **High** | `views/sales.py` (`SaleViewSet`) | Sales accept generic `PUT/PATCH/DELETE` (ModelViewSet, `SaleDetailSerializer` has writable model fields). | Any cashier can `PATCH /sales/5/ {"total_cost":"1","remaining_cost":"0"}` or `DELETE /sales/5/` → invoice altered/erased (stock is NOT restored on delete, payments cascade-deleted). Fix: allow only `get, post` + the actions. |
| B-06 | **High** | `views/sales.py` `cancel` | (a) Not wrapped in a transaction (no `ATOMIC_REQUESTS`) — a failure mid-loop leaves half-restored stock. (b) Installments of the cancelled sale remain unpaid and are still listed by `/installments/due/`, dashboard "due installments" and cash-flow inflows. (c) Payments already received stay in cash balances with no refund record. | Cancel an installment sale → cashier still sees its installments as overdue; forecast shows money that will never come; cash account keeps the down payment with no refund trail. |
| B-07 | **High** | `services.py:67-73` (`_available_lots`) | FIFO allocation ignores the sale's branch: lots from **any** branch are consumed, while the POS shows per-branch stock. | Branch A has 0 units, branch B has 5. A sale at A succeeds and consumes B's lot; movement is logged at A; branch stock figures drift from reality. |
| B-08 | **Medium** | `views/catalog.py:117-150` (`adjust`) | Negative adjustment only decrements `stock_quantity`; lots are not consumed. Also no check that stock stays ≥ 0. Item `PATCH` also lets managers write `stock_quantity` directly. | Write off 3 damaged units → lots still hold them → sales can still sell those 3 (FIFO finds lots) → `stock_quantity` goes negative; inventory value on the balance sheet stays inflated. |
| B-09 | **Medium** | `services.py:41-62` | Sequence uses string ordering: after `INV-2026-9999`, `INV-2026-10000` sorts lower, so the next number computed is again `10000` → unique violation → every new sale fails (HTTP 500) for the rest of the year. Numbers are global across all businesses, so the 10 000 limit is shared by all shops. | Platform reaches 10 000 invoices in a year → POS stops working. |
| B-10 | **Medium** | `services.py` (`next_sequence_number`, `allocate_fifo`, `record_installment_payment`) | No row locking (`SELECT … FOR UPDATE`). | Two cashiers save at the same moment → same invoice number → one gets 500; or both allocate the last unit → `quantity_remaining` negative; two simultaneous installment payments can both pass the "exceeds balance" check. |
| B-11 | **Medium** | `views/suppliers.py` `receive`, `add_item` | Receive works on DRAFT and CANCELLED orders; add_item works on CANCELLED orders; DELETE of a received PO is allowed (receipts cascade away, lots stay). | Receive a cancelled PO → stock and payables appear for an order you cancelled; deleting a received PO removes it from the supplier ledger while its stock remains. |
| B-12 | **Medium** | `serializers.py` `SaleCreateSerializer.create` / `services.record_sale` | `ValueError`s from the service (insufficient stock, down payment ≥ total, 0 installments) are not converted to 400. | Cashier sells more than in stock → HTTP **500** instead of a clear "Insufficient stock" message (frontend shows generic error). |
| B-13 | **Medium** | `views/reports.py:121-157`, `223-312` | P&L: includes **cancelled** sales; revenue ignores invoice-level discounts; expenses filtered by `created_at` not `expense_date`; interest income never counted. Balance sheet: cash is current (not as-of), inventory uses current remaining qty, receivables include interest that retained earnings don't. | Give a 10 % invoice discount → P&L revenue overstated by that amount; cancel a sale → its profit still shows; back-dated expense lands in wrong month; balance sheet `difference` ≠ 0 in normal use. |
| B-14 | **Medium** | `views/suppliers.py:61-73`, `views/reports.py:183-210` | Received value = order total × received qty ÷ ordered qty, not Σ(received_qty × unit_cost). | PO: 1 TV @ 100 000 + 9 cables @ 1 000. Receive only the TV → payable shown 10 900 instead of 100 000. |
| B-15 | **Medium** | `services.py:244-268` | Installment rounding only distributes *positive* leftover cents. | 100.00 over 3 → 33.33×3 = 99.99 (+0.01 handled ✓); but e.g. 0.05 over 3 → base 0.02 ×3 = 0.06 → sum exceeds remaining by 0.01 and is never corrected → sale can never be fully closed exactly. |
| B-16 | **Medium** | `services.py:359-375` | "One-time" interest is charged again on **every** partial payment that leaves a shortfall on the selected installment. | Rate 10 %, installment 1000: pay 200 (interest 80), pay 200 again (interest 60 more) … customer is charged repeatedly. |
| B-17 | **Medium** | `services.py:322-357` | Roll-forward starts at the selected installment; if earlier installments are unpaid, part of the payment may not be applied to any installment, yet `remaining_cost` is reduced by the full amount. | 3×1000, #1 unpaid, pay 2500 on #2 → #2 and #3 settled (2000), 500 applied nowhere; sale remaining shows 500 while #1 still owes 1000. |
| B-18 | **Medium** | `serializers.py:421-438` (`SaleCreateSerializer`) | No bounds on `discount_value` (negative or >100 %), `down_payment` (negative), `tax_rate` (negative), `installment_interval_days` (0/negative); cashier discount cap (`Business.cashier_discount_cap`) is **never enforced** (backend or POS). | Cashier enters 90 % discount (cap 20 %) → accepted. Negative discount raises price. Interval 0 → all installments due today. |
| B-19 | **Medium** | `views/auth.py`, `permissions.py` | `Business.is_active=False` is never checked. | Super admin deactivates a non-paying shop → its users keep logging in and trading. |
| B-20 | **Medium** | `frontend/src/pages/NewSalePage.jsx:85-88` | POS customer dropdown loads only the first page (20) of customers, with no search. | Shop with 50 customers → cashier cannot pick customers 21+ on a sale. |
| B-21 | Low | `models.py` Sale.status | `CLOSED` is never set; fully paid sales stay `OPEN`. | Filters/reports keyed on status can't distinguish settled sales (they use `remaining_cost` instead); harmless today but misleading. |
| B-22 | Low | `serializers.py:266` (`CashAccountSerializer.get_balance`) | Recomputes every account's balance for every row (N×4 queries). | Slow cash-account lists as data grows. |
| B-23 | Low | `views/reports.py` DashboardView/Summary/BranchSales docstrings vs code; frontend `DASHBOARD_VIEWERS` | Super admin sees "Dashboard" in the menu but the API returns 403 for them. | Super admin clicking Dashboard sees error widgets. |
| B-24 | Low | `models.py` Customer.id_card_photo | ID-card photos are stored in the public media folder with guessable-ish paths and no auth. | Anyone with the URL can view a customer's NIC photo (privacy / PDPA risk). Serve through an authenticated endpoint instead. |
| B-25 | Low | `hooks/useConnectionState.js` | 1.5 s timeout on slow shared hosting flips the pill to Offline; every open tab polls every 5 s. | False "Offline" warnings; avoidable load on the host. |

### Gaps (missing features rather than bugs)

| ID | Gap |
|---|---|
| G-01 | No SPA screen to create **expense categories** (API exists, admin-only) → a new business cannot record expenses without super-admin help. |
| G-02 | No SPA screens for **supplier payments**, **supplier ledger**, **stock adjustment**, **payments registry**, `/reports/sales` and `/reports/stock`. |
| G-03 | Recurring expenses never post real expenses (forecast only); no cron jobs exist yet (spec mentions reminders/alerts). |
| G-04 | No returns/refunds, no stock transfer between branches, `User.branch` not enforced. |
| G-05 | Many lists fetch a single page (`page_size=100`) with no paging UI — data beyond 100 rows is invisible in pickers. |
| G-06 | `Promotion` and `Report` tables are unused. |
| G-07 | Offline sale queueing is spec-only (`docs/offline-sync-spec.md`). |

---

## 13. Repository map

```
backend/
  manage.py, passenger_wsgi.py, requirements*.txt, .env*.example
  shopapi/settings.py   env-driven config        shopapi/urls.py  admin/api/schema/docs/media
  core/models.py        all tables (§4)          core/services.py business logic (§5)
  core/serializers.py   JSON shapes & validation core/permissions.py roles
  core/middleware.py    sets request.tenant      core/viewsets.py tenant-scoped base
  core/views/*.py       endpoints (§6)           core/urls.py     route map
  core/admin.py         Django admin site        core/tests.py    200 tests (§11.3)
  core/management/commands/seed_demo.py          demo data
frontend/
  src/api, src/context, src/routes, src/components, src/hooks, src/utils, src/pages (§8)
  .env.production       VITE_API_URL
docs/
  SYSTEM-BLUEPRINT.md   this file
  deploy-cpanel.md      deployment runbook
  offline-sync-spec.md  future offline mode design
system-spec.md          original design spec (intent; may differ from code)
deploy/                 (gitignored) production zips, env, terminal commands
```
