# WATCHREWARDS — Progress Log

> Session snapshot · 16 September 2026 · branch `main`

## What this project is now

A mobile-first **Watch & Earn** platform for Kenya, built to the supplied screen
specifications (390 × 844 reference viewport, screens 01 – 30). The previous
TaskCash task-rewards product has been replaced end to end: frontend, API surface,
schema, accounting and payment handling.

## ✅ Built

### Mobile app (`frontend/`)
- `index.html` + `assets/js/app.js` — single-page hash router covering every specified
  screen: splash, login, registration, home (promo banner + 2 × 2 quick stats),
  Watch & Earn, player with claim, wallet, deposit, deposit status, withdraw,
  confirmation sheet, submitted state, transaction history (filter tabs + infinite
  scroll), team, rewards, notifications, profile / personal information / M-Pesa
  details / security, plus empty and error states (including session expiry).
- `assets/css/app.css` — the whole design system as CSS variables (colours, 10/14/20 px
  radii, 50/40/52 px control heights, 20 px page padding, 70 px bottom nav, 64 px
  header), 360 → 430 px responsive rules and a centred shell on desktop.
- Bottom navigation (Home · Watch · Wallet · Team · Profile) with safe-area padding and
  enough content padding that it never covers buttons.
- Honest sandbox labelling: whenever the API reports a sandbox provider, the deposit
  and payout screens state that no real M-Pesa request is sent.

### Admin console (`frontend/admin.html`, `assets/js/admin.js`, `assets/css/admin.css`)
Dashboard (six database-backed cards), Users, Videos (add / edit / enable / disable /
delete), Deposits (verify with the provider), Withdrawals (submit or check a payout,
mark failed), Rewards, Referrals, Notifications broadcast, Settings, Audit Logs.
Desktop/tablet responsive sidebar layout.

### Backend
- `services/ledger.js` — immutable ledger: unique `txn_id`, unique `idempotency_key`,
  credits, reservations for payouts, settlement, reversal with a compensating entry,
  wallet totals, per-user reconciliation and audit writes.
- `services/payments/` — provider abstraction (`provider.js` interface,
  `mpesa-provider.js` live Daraja STK + B2C + status queries + callback parsing,
  `sandbox-provider.js` development-only with `simulate()` that throws in production,
  `index.js` registry plus deposit/withdrawal reconciliation).
- `services/watch.js` — watch sessions and the only code path that can produce a watch
  reward: required duration, progress that can only move forward and never exceeds real
  elapsed time, per-video and platform daily limits, `watch:<session_id>` idempotency,
  plus referral rewards paid once on a referred user's first verified reward.
- `services/settings.js` — operator-editable platform settings with a public subset.
- Routes: `watch`, `home`, `wallet` (deposits, withdrawals, quotes, transactions,
  summary), `team`, `notifications`, `admin`, `auth` (phone login, registration,
  profile, phone/payout verification, sessions, logout-all), `mpesa` (callbacks +
  development sandbox simulator), `public` (config, health).
- `middleware/auth.js` — httpOnly JWT with **revocable sessions** (logout-all really
  kills other devices), revocation-aware guard, double-submit CSRF.
- `db/schema.sql` rewritten: users, videos, watch_sessions, deposits, withdrawals,
  wallet_transactions, referrals, notifications, email_tokens, app_settings,
  login_sessions, audit_logs.
- Removed the whole task/package/promo/KYC/country surface: `routes/tasks.js`,
  `routes/dashboard.js`, `services/{rewards,earnings,kyc,mpesa,mpesa-webhook}.js`,
  `lib/countries.js`, `db/migrate.js`, `scripts/simulate.js` and every TaskCash page.

### Verification
- `npm run check` — 31/31 JS files pass `node --check` (backend + frontend).
- `npm run smoke` — **74/74** API checks against a real server on an isolated store:
  registration/login/logout, watch validation (reward refused before the requirement is
  met, duplicate claim not paid twice), deposit pending → verified → credited once,
  withdrawal reservation and no double spend, referral reward, ledger/history accuracy,
  notification read state, cross-user isolation, profile/security checks, admin cards
  from the DB, admin cannot complete a payout, production payment guard, no
  guaranteed-profit claims, no credentials in the frontend.
- `npm run smoke:ui` — **51/51** checks in headless Chrome: every screen renders the
  specified content at 390 × 844, the player opens from Watch Now, the deposit status
  screen stays Pending until verified then flips to Successful with a `SANDBOX-`
  reference, the withdrawal confirmation sheet masks the number, bottom navigation
  works, the admin console is gated and every admin view renders, and no JavaScript
  errors occur.

## 📌 Still open / operator actions

1. **Live M-Pesa credentials** — set `MPESA_*` and `MPESA_B2C_*` to move real money;
   until then deposits and payouts are refused (or sandbox-labelled in development).
2. **SMS verification for phone/payout changes** — currently re-authentication with the
   account password plus an audit entry; add an OTP provider if the business needs SMS.
3. **PostgreSQL run-through** — the suite runs against the JSON store in this
   environment; boot against Supabase and re-run `npm run smoke` before launch.
4. **Scaling the transaction list** — pagination is offset-based; switch to a cursor if
   histories grow very large.
5. **Operational monitoring** — Daraja callback failures are logged but there is no
   alerting yet.

## ⚠️ Standing rules for this project

- Never fabricate a payment, a receipt, a balance or a referral.
- A deposit/withdrawal status changes only from a verified provider result.
- The client never supplies a balance, a reward or a completion time.
- No guaranteed returns, anywhere, ever.
- Production must never label a simulated transaction as a real M-Pesa payment.
