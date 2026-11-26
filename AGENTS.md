# Agent guide

Multi-tenant appliance-shop management system (Django REST API + React/Vite SPA, MySQL).

Read these before changing or rewriting anything:

1. **`docs/SYSTEM-BLUEPRINT.md`** — the authoritative, language-neutral description of the
   data model, business rules, API contract, frontend screens, rewrite guide and the
   **known bugs list (§12)**. Start here.
2. `docs/deploy-cpanel.md` — production deployment (cPanel, Passenger/LiteSpeed, MySQL).
3. `system-spec.md` — original design intent (older; the blueprint wins where they differ).
4. `docs/offline-sync-spec.md` — planned offline mode (not implemented).

Working rules:

- Backend tests: `cd backend && .venv/Scripts/python manage.py test core` (232 tests, must stay green).
- Frontend: `cd frontend && npm run build` (production API URL comes from `.env.production`).
- Every business-level query must be scoped to `request.user.business`; every incoming
  foreign key must be validated against that business (see blueprint §3, §12 B-02).
- Money is decimal with 2 dp, never float. Stock/sale/payment mutations must be atomic.
- Keep the API contract in blueprint §6 stable — the SPA depends on it. If you change it,
  update the blueprint in the same change.
- `deploy/` is gitignored and contains production secrets — never commit it.
