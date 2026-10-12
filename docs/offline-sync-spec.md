# Offline Cashier + Sync — Architecture Spec

Status: **DRAFT for review — no code written.**
Author: Sisyphus, 2026-10-08 (Session 8)
Relates to: user request "cashier can do his job hosted app or locally hosted. if
there is a connection then sync with the db. there is another db in locally which
has data of that business only and cashier can do anything and it update the local
db. then it sync with host if there is a connection."

---

## 1. Goal & scenario

Cashiers may run the application in one of two modes:

- **Hosted (current):** browser talks to the central API. No change.
- **Local/offline:** the cashier machine keeps a local copy of *that business's*
  data, the cashier keeps working (sales, installment payments, customers) with
  no connection, and the local copy syncs with the host whenever a connection
  exists.

Hard constraint: **money, stock, and balances must survive sync without
corruption.** This document decides *how* sync works so that property holds.
It is deliberately the thing to agree before writing code.

---

## 2. The one decision everything hangs on: event log, not field replication

The naive design — "replicate rows, then copy changed fields between the two
DBs" — is the classic way to silently corrupt a bookkeeping app. It uses
**last-write-wins on state**, and state fields here are derived from sequences
of actions:

```
Installment.paid_amount       ← sum of payment actions
Installment.is_paid           ← paid_amount >= amount + interest_charged
Installment.interest_charged  ← computed when an underpayment action happens
Sale.remaining_cost           ← total_cost − payments + interest
Item.stock_quantity           ← stock movements (sales, receipts, adjusts)
```

Two offline cashiers paying the *same* installment both "set"
`paid_amount = 300` at different times → the second write clobbers the first,
and the host can never know both payments happened.

**Decision: the local DB is a cache + an appender of *events*. The host is the
only place that replays events into state.** Sync = move events, not fields.

### 2.1 What an "event" is (concrete, using this app's actions)

An event is an append-only, immutable record of an action a cashier took:

```json
{
  "event_id": "9f0c…-uuid",            // generated on the device (globally unique)
  "device_id": "dev-abc-123",          // which cashier machine
  "type": "sale.created",              // one of the event types below
  "created_at": "2026-10-08T10:15:00Z",// device clock (used for display only)
  "payload": { … }                     // the action's data
}
```

Event types **phased in this order** (matches what a cashier actually does):

| Event type | Payload (real fields, real prices math) |
|---|---|
| `customer.created` | name, phone, nic, address |
| `sale.created` | branch, customer (or null=walk-in), lines `[{item_id, quantity}]`, discount_type/value, tax_rate, is_single_payment, down_payment, number_of_installments, installment_frequency, installment_interval_days, cash_account, device invoice_no |
| `payment.recorded` | sale (local id), installment (local id), amount, method, cash_account, device timestamp |

**What is NOT an event:** `paid_amount`, `is_paid`, `remaining_cost`,
`interest_charged`, `stock_quantity`, `fifo_cost` — nope. Those are *derived* on
the host by replaying events. The local UI may display its optimistic
projection of them, but they are never sent.

### 2.2 Why this makes the money safe (the deciding example)

- **Two cashiers, same installment, offline.** Events: `payment.recorded(300)`
  from A, `payment.recorded(250)` from B. Both replay in order on the host →
  `paid_amount = 550`, `interest_charged` recomputed per the billing rule at
  each replay. **No write ever destroys another.** Exactly what a cash drawer
  does with two physical payments.
- **Interest (Session 7 rule) is host-computed at replay:** `shortfall × rate/100`
  using the business's *current* `installment_interest_rate` at the moment the
  event replays — same rule as online mode. Simple and identical behavior;
  no special offline math. (Trade-off noted in §8.)
- **A payment on a sale the host has since cancelled** → replay rejects it with
  a clear `rejected_reason`; the device shows the cashier "this payment needs
  review" instead of silently writing a ghost transaction.

---

## 3. What the existing code already gives us for free

Grounding this spec in the real codebase (all verified this session):

- **Tenant partitioning already exists everywhere.** Every model inherits
  `BusinessModel` (`business` FK) + `TenantManager`. "A local DB with only that
  business's data" is a `WHERE business_id = X` filter at bootstrap — no
  redesign.
- **All state-mutating logic is already centralized** in
  `backend/core/services.py` (`record_sale`, `record_installment_payment`,
  `record_purchase_receipt`, …) inside `@transaction.atomic`. The sync engine
  reuses exactly these functions to replay events — the replay path *is* the
  online path. No second implementation of the money math.
- **Roles are already enforced** (`IsCashierOrAbove` / `IsManagerOrAbove` /
  `IsBusinessAdmin`); the device token maps to a user, so replay runs under the
  same permission model as the API.
- **`next_sequence_number`** (`services.py:41`) is a **MAX+1 heuristic** —
  `INV-{year}-{seq:04d}` computed by scanning the business's largest existing
  document number. **Even online this is racy** (two concurrent requests can
  mint the same number). Offline demands a real answer for invoice numbers — §5.4.
- **Frontend fields already capture the needed event payloads** —
  `NewSalePage` (lines/discount/tax/installment fields),
  `InstallmentPaymentsPage`/`SaleDetailPage`/`InstallmentsPage` collect modals
  (amount/method/cash_account), `CustomersPage` CRUD. The offline flow reuses
  these forms; only the *transport* changes.

---

## 4. Architecture

### 4.1 Devices and identity (host side)

New host model `Device`:

```
Device: id, business FK, device_id (UUID, generated once per install),
        name (e.g. "Counter 1"), user FK (the cashier the device is bound to),
        created_at, last_seen_at, is_revoked
```

- One device per cashier machine. Bound to **one user** at first login
  (the cashier whose token activates it).
- A revoked device's queued events are rejected on next contact.

### 4.2 Local DB (device side)

SQLite (already the project's dev engine; zero new infra). Contents:

- **Bootstrap snapshot** (fetched on first connect, refreshed on sync):
  that business's `Item` (+ prices/discounts), `Category`/`Brand` (for search),
  `Customer`, `CashAccount`, `Branch` list, active `SeasonalDiscount`,
  business constants (`tax_rate`, `installment_interest_rate`,
  `cashier_discount_cap`, `max_installments`), and a summary of open
  `Sale` + `Installment` (invoice_no, remaining_cost, due dates) for the
  collect screens.
- **Pending events** (append-only queue): the device's own unresolved events.
- **ID mapping table**: `local_id (uuid) ↔ server_id (pk)` returned by the host
  after each sync, so later events can reference earlier offline creates.

### 4.3 Sync protocol (two-phase, on connection)

```
1. PUSH   POST /api/sync/push/    { device_id, events: [ … pending … ] }
2. PULL   GET  /api/sync/pull/?since=<cursor>
```

**Push** — the host, in a single `@transaction.atomic` block, replays each
pending event **in device arrival order** through the *existing* service
functions, e.g. `sale.created` → `record_sale(...)`. Per event it returns:

```json
{ "event_id": "…", "status": "applied", "server_id": 123,
  "id_mapping": { "item-9f0c": 42, "inst-0001": 7 }, "invoice_no": "INV-2026-0033" }
{ "event_id": "…", "status": "rejected", "reason": "Insufficient stock for HT-002.",
  "requires": "manager_review" }
```

Device then: flush applied events, store `id_mapping`, surface rejected ones
to the cashier ("2 sales waiting to sync — review with manager").

**Pull** — the host returns everything the device still lacks:
`DeviceEvent` entries from other machines of the same business, plus
updated rows it needs (new items/prices, business settings, other paid
installments). The device merges them into its snapshot so its UI reflects
other counters' sales. **This is how cashier B "sees" a payment A made offline.**
Deliverables: eventually consistent, never conflicting.

### 4.4 The host `DeviceEvent` table (what makes multi-device work)

```
DeviceEvent: id, business FK, device FK, event_id (uuid, unique),
             type, payload (JSON), created_at (host receipt time),
             status (applied/rejected), result (JSON: ids/invoice/errors)
```

Every applied event becomes a row. `pull` = "give me `DeviceEvent`s with
`id > my cursor` for my business, plus referee rows newer than my last
snapshot". This single table is both the audit trail and the replication log.

---

## 5. The hard parts — decided up front

### 5.1 Stock conflicts (the genuinely hard one)

Offline cashier A sells 300 units of HT-002; offline cashier B sells 200; the
host has 400. Push order decides:

- A's `sale.created` replays first → consumes 300 → stock 100.
- B's replays second → `allocate_fifo` fails → event **rejected, requires
  manager_review**, not silently applied. The host can even **partially apply**
  (sell B's 100 available, reject the remaining 100) — a product decision, §8.

A few FIFO/price subtleties to flag (not blockers — they are host-side replay
behavior, so they behave identically to online):

- `allocate_fifo` runs on the host's real lots at replay time → costs are
  authoritative, never from the device.
- `apply_seasonal_discount` uses the host's *current* active discounts. A
  discount that expired while offline applies at replay — the host is the
  source of truth for pricing, and the device only previews.

### 5.2 Payment duplication on the same installment

Two `payment.recorded` events for the same installment are **both valid and
both apply** (a customer paying twice is real money twice). What is *not*
allowed: a device re-sending the *same* `event_id`. The host dedupes on
`event_id` (unique constraint) → **at-least-once delivery + exactly-once
application.** This is the entire anti-double-charge story and it lives in one
column.

### 5.3 Client-generated IDs → server IDs

Events reference items/customers/installments by **local UUID**
(`local_ref`) because server PKs don't exist yet for offline-created rows.
The push response returns the `id_mapping`; the device writes it into the
mapping table and patches all later events. Straightforward, mechanical,
testable.

### 5.4 Invoice numbers (needs a product decision — see §8)

`next_sequence_number`'s MAX+1 is racy even online, so it cannot be the offline
answer. Three options:

| Option | How | Trade-off |
|---|---|---|
| **A. Per-device range reservation** | On first connect, device "checks out" a block, e.g. `INV-2026-9xxx` owned by device `dev-abc`; offline sales draw from it | Clean numbers, no renames; needs a reservation table + block-size tuning; a device that dies wastes its block |
| **B. Offline placeholder → rename on sync** | Device mints `INV-OFF-{uuid-short}`; host reassigns the real number on replay and returns it | Number on printed offline receipts is not the final one (bad if cashiers print A4 bills offline — this app does) |
| **C. Host-assigns at push for payment events only** | Payments reuse the sale's existing number (they already do — payments don't mint numbers), so only *sale creation* needs the answer | Same as B for sales; fine only if sales rarely go offline |

**Recommendation: A**, because this app prints `invoice_no` on A4 bills — the
printed number must be final. This also fixes the pre-existing online race by
giving every write a real lock source.

### 5.5 Auth, offline

- Online: unchanged (JWT refresh flow already exists).
- Offline: the device keeps a **local session** (device_id + bound user +
  offline grace period, e.g. token cached up to N days). On reconnect, the host
  re-validates the user token; if revoked or role-changed, the device's events
  are rejected and the device must re-authenticate.
- Device theft: `Device.is_revoked` → all its pending events rejected on next
  contact. Cashier-level PIN on the client is a client-side concern, out of
  this spec's server scope.

---

## 6. What stays server-authoritative (the trust boundary)

The device **previews and queues only.** Everything below is computed **only on
the host**, with the exact same functions online mode uses:

- Sale totals: subtotal/discount/tax, `total_cost`, FIFO cost, stock movement
- Installment splits (`_create_installments`), payment roll-forward, **one-time
  shortfall interest**, `is_paid`/`remaining_cost`/`interest_charged`
- Invoice numbering, business settings, permissions

The local DB, in other words, is **a read cache plus a pending-event queue** —
which is precisely why it cannot corrupt the books. A cashier's offline screen
may *show* "est. total 19,750.50", but `19,750.50` official comes out of
`record_sale` at replay, and the device displays the host's number after push.

---

## 7. Rollout phases (each is independently shippable, in order of cheap→real)

### Phase 0 — "spotty connection" (days, not weeks) ⭐ recommended first
Do the *scenario* question first (§8.1). If the real pain is **intermittent
connectivity at the counter**, you do not need a local DB at all:
- Browser **IndexedDB read cache** of items/customers/installments (what the
  collect/POS screens read)
- **Write-queue with auto-retry**: a sale/payment while offline goes into an
  in-browser queue; a background retry flushes it when `navigator.onLine` →
  exactly-once via a client-generated idempotency key (the same
  `event_id` idea, one column on the existing endpoints)
- Zero backend sync engine, zero Device/DeviceEvent model, zero schema drift
  risk. Ships in the existing hosted app.

### Phase 1 — local app + snapshot + queued creates (weeks)
The real local DB of Phase 4, but **restricted writes**: offline `sale.created`
and `customer.created` only (no offline payments yet). Establishes Device,
DeviceEvent, bootstrap snapshot, push/pull, ID mapping, invoice reservation —
the entire sync spine — while payment replay (the scariest math) stays online.

### Phase 2 — offline payments (the distributed-system milestone)
`payment.recorded` events, roll-forward + interest at replay (Session 7 rules),
per-installment dedupe-by-`event_id`, rejected-payment review surface.
**This is the phase where the money guarantee is proven.**

### Phase 3 — beyond
Multi-device dashboards (per-device pending/rejected counts for the manager),
offline for manager/admin roles, schema-version negotiation (see §8.3), device
upgrade flow.

---

## 8. Open decisions — need the user's answers

1. **Is the scenario "bad internet at the counter" or "truly offline for
   hours/days"?** Phase 0 (cache+queue, 5% of the effort) applies to the
   former; Phases 1–2 (local replica + event sync) to the latter.
2. **Inventory over-consumption policy** (two offline devices oversell an
   item): reject-and-alert (safe, simplest) vs. partial-apply vs. allow-negative
   stock with manager review?
3. **Invoice numbering:** per-device reservation (my rec) vs. rename-at-sync?
4. **Offline interest timing:** use the business rate *at replay* (identical to
   online, my rec) vs. rate *at event creation* (device-stamped)?
5. **Offline printing:** do cashiers need the A4 bill to print offline with a
   **final** invoice number? (Determines 3.)

---

## 9. Scope explicitly NOT in this spec (unless asked)

- Offline editing of master data (items, prices, users, settings) — stays
  host-only, admin-only
- Purchases/POS receipts/expenses offline (cashier role doesn't touch these)
- True multi-master bidirectional replication / CRDTs — deliberately avoided;
  the event-log + server-replay model is deterministic and auditable, and CRDTs
  would be over-engineering for a single-business cashier surface
- Mobile/PWA packaging — the "local app" is assumed to be the existing React
  app pointed at a local server or running as a packaged desktop app; the
  chosen distribution mechanism is a separate conversation

---

## 10. Bottom line

The idea is sound and the codebase is unusually well-positioned for it
(tenant-everything + centralized transactional services). The *danger* is
treating it as a sync-copy problem. Treat it as an **append-only event ledger
whose replay is the existing service layer**, and money/stock correctness falls
out of code that already works and is already tested (170 backend tests today).
Start with §8.1 → if the pain is connectivity, do Phase 0 and stop there; if
true offline, Phase 1 builds the spine and Phase 2 proves the money.