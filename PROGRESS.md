# TaskCash — Progress Log

> Session snapshot · September 14, 2026 · branch `main` (1 commit, uncommitted work in tree)

## Where the project stands

**TaskCash v2.0.0** — originally a Kenya-only M-Pesa task-rewards platform, now mid-way
through its **global/multi-currency expansion**. All work below is **uncommitted**
(32 modified files + 6 new files, +651/−265 lines).

## ✅ Completed (this phase)

### Multi-country / multi-currency support
- `backend/lib/countries.js` — country + currency catalog (~200 countries, ISO2:Name:Currency),
  country-aware payment method registry (M-Pesa = KE only, honest "coming soon" elsewhere)
- `backend/lib/money.js` — backend currency formatting mirror
- `frontend/assets/js/countries.js` — frontend catalog + country/currency pickers on register & settings
- Schema: `users.country_code/currency/currency_code`, `tasks.availability_type/countries`,
  `task_rewards` table (per-country rewards, UNIQUE(task, country)), `currency_code` on
  completions/withdrawals/deposits, legacy `ALTER TABLE ... IF NOT EXISTS` backfills
- `backend/services/rewards.js` — reward engine: resolve per-country reward → global fallback;
  admin validation (`validateRewardsPayload`), `setTaskRewards`, availability check. **Rule: rewards
  are never FX-converted** — each country's amount is configured separately
- `backend/db/migrate.js` — boot-time backfill: legacy users → KE/KES, historical txns → KES
- `package.json` → `taskcash` v2.0.0, added `npm run simulate`

### Load simulator (dev tooling)
- `scripts/simulate.js` — N simulated users (default 500) register across 10 currencies and
  every 2s fire a deposit + withdrawal of random amounts at the real wallet endpoints.
  Env: `BASE_URL`, `USERS`, `INTERVAL_MS`

### Frontend updates
- Register/login/settings/wallet/admin/tasks pages updated for country & currency awareness
- Wallet page: country-aware deposit methods, withdraw methods, currency display

### Branding
- Renamed "TaskCash Kenya" → "TaskCash" across README, schema, package.json

## ✅ Verification status

- `npm run check` — **25/25 JS files OK**
- Not yet run end-to-end in this environment (server boot, seed, simulate)

## 📌 Next steps (pick up here)

1. **Commit the global-expansion work** — tree is fully uncommitted; suggest a commit before continuing
2. **Boot test:** `npm run seed` then `npm run dev` → register flow with country picker,
   deposit (demo STK), task submission, withdrawal
3. **Run the simulator:** `npm run simulate` against a dev server; watch admin wallet/withdrawal queues
4. **Admin task editor:** verify per-country rewards UI (task_rewards) round-trips create/edit
5. **Check `task_rewards` seeding:** sample tasks in `seed.js` may need per-country reward rows
6. **README/DEPLOY docs:** refresh env docs if any new vars were introduced
7. **Deployment:** Railway/Render config unchanged; confirm `DATABASE_SSL` + pooled Supabase string

## 🔑 Demo logins (after seed)

- User — `wanjiku` / `Demo@1234`
- Admin — `admin@taskcash.co.ke` / `Admin@1234`

## ⚠️ Standing rules for this project

- Rewards are **never** converted via exchange rates — configured per country only
- Payment methods not actually implemented must surface as "Coming soon" (never faked)
- This is a *rewards* platform, not an investment scheme — disclaimers stay everywhere
