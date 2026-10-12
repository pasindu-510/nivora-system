# YourShop Frontend

React SPA for the multi-tenant electric and kitchen appliances shop management
system. This is the scaffold phase (build order phase 8): routing, auth,
role gating, the API client, and shared components are in place; domain pages
are wired as functional placeholders for the page teams to fill in (phase 9).

**Stack:** React 18 · Vite 6 · React Router 6 · Axios · TanStack Query 5 ·
Tailwind CSS 4 · Recharts 3 — plain JSX (no TypeScript).

---

## Scripts

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Start dev server (default port 5173) |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build locally (port 4173) |

Deployment: upload the contents of `dist/` to `public_html/` so the SPA is
served at the site root (Apache history-mode fallback: all unknown paths must
rewrite to `index.html`).

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | `https://api.yourshop.lk/api` | Base URL of the Django REST API |

Defined in `.env` (copy from `.env.example`). For local backend work set:

```
VITE_API_URL=http://localhost:8000/api
```

Only `VITE_*` variables are exposed to the browser bundle — never put secrets
here.

---

## Folder structure

```
frontend/
├── index.html               # HTML shell + font loading
├── vite.config.js           # Vite + React + Tailwind v4 plugins
├── package.json
├── .env / .env.example      # VITE_API_URL
├── public/
│   └── favicon.svg
└── src/
    ├── main.jsx             # React entry
    ├── App.jsx              # QueryClient + Auth + Router providers
    ├── index.css            # Design tokens (@theme) + component classes
    ├── api/
    │   ├── client.js        # Axios instance, JWT storage, 401-refresh-retry
    │   ├── endpoints.js     # Typed helpers for every spec-section-6 endpoint
    │   └── queryKeys.js     # Central React Query keys (invalidation targets)
    ├── context/
    │   └── AuthContext.jsx  # Session: login/logout/me via /api/auth/me/
    ├── hooks/
    │   ├── useApiMutation.js  # Mutation wrapper with invalidation lists
    │   └── useDocumentTitle.js
    ├── routes/
    │   ├── index.jsx        # All 22 routes with role guards
    │   ├── menu.js          # Sidebar nav model (roles drive filtering)
    │   └── access.js        # Pure route -> roles matrix (unit-testable)
    ├── utils/
    │   ├── permissions.js   # Pure role helpers: canAccess, filterMenu
    │   ├── compressImage.js # Client-side image compression (~200 KB)
    │   └── format.js        # LKR currency, dates, file sizes, initials
    ├── components/
    │   ├── AppLayout.jsx    # Authenticated shell: sidebar + topbar + outlet
    │   ├── Sidebar.jsx      # Role-filtered nav, off-canvas below lg
    │   ├── Topbar.jsx       # User chip + sign out
    │   ├── RequireAuth.jsx  # Unauthenticated -> /login redirect
    │   ├── RoleGuard.jsx    # Wrong role -> in-layout 403 page
    │   ├── DataTable.jsx    # Shared list (loading/empty/row click)
    │   ├── Modal.jsx        # Accessible dialog (Escape/backdrop close)
    │   ├── FormField.jsx    # Label + error + hint wrapper
    │   ├── StatCard.jsx     # KPI tile
    │   ├── PhotoUpload.jsx  # Pick + compress to ~200 KB + preview
    │   ├── EmptyState.jsx   # Meaningful empty states
    │   ├── PageHeader.jsx
    │   ├── PlaceholderPage.jsx
    │   ├── FullPageLoader.jsx
    │   └── Icon.jsx         # Shared 24px stroke icon set
    └── pages/
        ├── LoginPage.jsx        # Polished sign-in
        ├── DashboardPage.jsx    # KPIs + sales-by-branch chart (Recharts)
        ├── ForbiddenPage.jsx    # 403 for role denials
        ├── NotFoundPage.jsx     # 404
        └── ... domain pages     # Functional placeholders (phase 9 targets)
```

---

## Routes (spec section 7.1 — 22 routes)

| Path | Access | Page |
|---|---|---|
| `/login` | public | Sign in |
| `/dashboard` | all roles | KPIs, sales-by-branch chart, low stock, due installments |
| `/sales/new` | business_admin, manager, cashier | POS |
| `/sales` | business_admin, manager, cashier | Invoice list |
| `/sales/:id` | business_admin, manager, cashier | Invoice detail + installments |
| `/installments` | business_admin, manager, cashier | Due/overdue collection |
| `/customers` | business_admin, manager, cashier | Customer list/create |
| `/items` | business_admin, manager, cashier | Catalog items |
| `/categories` | business_admin, manager | Category tree |
| `/brands` | business_admin, manager | Brand CRUD |
| `/stock/purchases` | business_admin, manager | Purchase orders |
| `/stock/receive` | business_admin, manager | Receive deliveries |
| `/stock/lots` | business_admin, manager | FIFO cost lots |
| `/stock/movements` | business_admin, manager | Stock audit trail |
| `/suppliers` | business_admin, manager | Suppliers + ledger |
| `/expenses` | business_admin, manager | Expenses |
| `/expenses/recurring` | business_admin, manager | Recurring templates |
| `/promotions` | business_admin, manager | Seasonal discounts |
| `/reports` | business_admin, manager | P&L, balance sheet, cash flow, tax |
| `/settings/finance` | business_admin | Cash accounts, capital entries |
| `/users` | business_admin | Users and roles |
| `/branches` | business_admin | Branch CRUD |

`super_admin` signs in and sees the dashboard; business management happens in
the Django admin (spec section 3.2). Unknown paths render the in-app 404.

---

## Auth flow

1. `POST /api/auth/login/` returns `{ access, refresh }` — both stored in
   `localStorage` (spec 7.2 allows this for v1).
2. Every request from `src/api/client.js` carries
   `Authorization: Bearer <access>`.
3. On `401`, the response interceptor calls `POST /api/auth/refresh/` once
   (concurrent 401s share a single refresh promise), retries the original
   request with the new access token, and otherwise clears tokens and emits
   `auth:logout` so the app redirects to `/login`.
4. `GET /api/auth/me/` supplies the user, role, business, and branch for the
   session; route guards and the sidebar menu both consume that role.
5. Sign-out clears tokens and the entire React Query cache.

---

## Role gating (pure, unit-testable)

`src/utils/permissions.js` exposes `canAccess(allowedRoles, role)` and
`filterMenu(menuGroups, role)` with no React dependency — cover these with
unit tests in the verification suite. `src/routes/access.js` mirrors the same
matrix as a plain object for path-level checks.

---

## Shared components

- **DataTable** — columns/rows API with loading skeletons, empty states, row
  click, horizontal scroll for tablets.
- **Modal** — Escape and backdrop close, sizes sm–xl, optional footer.
- **FormField** — label + required marker + error/hint text with aria wiring.
- **StatCard** — KPI tile with tone variants and optional currency formatting.
- **PhotoUpload** — file pick, client-side JPEG compression to ~200 KB
  (canvas quality ladder), preview, remove; hands a `File` to the parent for
  multipart upload.

## Design system

Tokens live in `src/index.css` under Tailwind v4's `@theme`: brand scale,
surface/sidebar colors, radii, elevation, and the Plus Jakarta Sans +
JetBrains Mono type pairing. Component primitives (`card`, `btn-*`, `input`,
`label`, `badge`) are defined once in `@layer components` — new UI should
compose these plus the shared components rather than inventing one-off styles.

## API surface

`src/api/endpoints.js` implements every endpoint from spec section 6:
auth, dashboard, installments, branches, users, categories, brands, items,
stock-movements, stock-lots, suppliers (+ledger), purchases (+receive,
cancel), customers (+history), sales (+installments, cancel), payments,
seasonal-discounts, cash-accounts, capital-entries, expense-categories,
expenses, recurring-expenses, supplier-payments, and the four reports
(profit-loss, balance-sheet, cash-flow, tax).
