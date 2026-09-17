# WATCHREWARDS

A mobile-first **Watch & Earn** platform for Kenya: users watch eligible videos, earn
verified rewards, and withdraw to **M-Pesa**. Node.js + Express + PostgreSQL/Supabase
API, vanilla-JS single-page mobile app (390 × 844 reference viewport), WebSocket
notifications and a desktop admin console.

> **Money rules, enforced in code**
> - Rewards exist only for watch sessions the **server** verified (real elapsed time,
>   progress clamped server-side, daily limits).
> - Balances live in an **immutable ledger** (`wallet_transactions`); the client never
>   sends a balance and no endpoint trusts one.
> - A deposit becomes `Success` **only** from a verified M-Pesa result, never because a
>   user tapped *Continue*.
> - A withdrawal reserves the amount immediately and stays `Pending` until the payment
>   provider confirms the payout. Admins cannot mark a transaction paid.
> - Payment provider credentials live **only** in server-side environment variables.
> - No guaranteed returns anywhere: deposits do not earn profit or interest.

---

## Screens

| # | Screen | Route |
|---|---|---|
| 01 | Splash (`WATCH • EARN • WITHDRAW`) | `/` |
| 02 | Login (phone + password) | `#/login` |
| 03 | Registration (+ optional referral code, terms) | `#/register` |
| 04–05 | Home (greeting, promo banner, 2 × 2 quick stats) | `#/home` |
| 06 | Watch & Earn task list | `#/watch` |
| 07 | Video / task player with claim | `#/watch/:videoId` |
| 08 | Wallet (balance card, actions, recent transactions) | `#/wallet` |
| 09–10 | Deposit + deposit status (Pending / Successful / Failed) | `#/deposit`, `#/deposit/:reference` |
| 11–12 | Withdraw + confirmation sheet + submitted state | `#/withdraw` |
| 13 | Transaction history with filter tabs | `#/transactions` |
| 14 | Team / referrals | `#/team` |
| 15 | Rewards | `#/rewards` |
| 16 | Notifications | `#/notifications` |
| 17–20 | Profile, personal information, M-Pesa details, security | `#/profile/...` |
| 21–24 | Admin dashboard, videos, deposits, withdrawals | `/admin.html` |
| 25 | Bottom navigation (Home · Watch · Wallet · Team · Profile) | — |
| 26 | Empty / error states, including session expiry | — |
| 29 | Responsive 360 → 430 px, centred shell on desktop | — |

## Quickstart

```bash
npm install
cp .env.example .env          # defaults are development-safe
npm run seed                  # admin, demo user, videos, platform settings
npm run dev                   # http://localhost:3000
```

**Demo logins** (after seed)
- User — `0799000001` / `Demo@1234`
- Admin — `admin@watchrewards.app` / `Admin@1234` (admin console at `/admin.html`)

**Zero infrastructure:** with no reachable PostgreSQL the app falls back to a JSON
store (`data/db.json`); `DB_MODE=json` forces it. Set `DATABASE_URL` (Supabase pooled
string works) for production — `schema.sql` is applied at boot.

## Payments (real architecture)

`backend/services/payments/` is a provider abstraction implementing
`createDeposit · verifyDeposit · createWithdrawal · verifyWithdrawal · handleCallback`.

| Mode | When | Behaviour |
|---|---|---|
| `mpesa` (live) | `MPESA_APP_KEY` + `MPESA_APP_SECRET` set | STK Push collections, B2C payouts, STK-query / transaction-status verification, `/api/mpesa/callback` |
| `sandbox` | development without credentials | records a local reference only, **never** returns success; every record is stamped `SANDBOX-` and the UI says so |
| `unconfigured` | production without credentials | deposits and payouts are refused (HTTP 503) — nothing is faked |

The sandbox simulator (`/api/mpesa/sandbox/callback`, admin *SIMULATE* buttons) throws
in production, and `NODE_ENV=production` never exposes it.

## Accounting

- `wallet_transactions` — immutable ledger, unique `txn_id`, unique `idempotency_key`,
  types `DEPOSIT · WATCH_REWARD · REFERRAL_REWARD · WITHDRAWAL · FEE · REVERSAL`,
  statuses `PENDING · COMPLETED · FAILED · REVERSED`.
- Duplicate provider callbacks are replay-safe: a settled deposit/withdrawal is never
  settled twice and the ledger key already exists, so the wallet cannot be credited twice.
- Withdrawals reserve funds (`balance → pending_balance`) so the same money cannot be
  withdrawn twice while pending; failures release the reservation.
- Watch rewards are keyed `watch:<session_id>`; referral rewards `referral:<user_id>`
  (paid once, when the referred user completes their first verified watch reward).
- Every admin action is written to `audit_logs`.

## Verification

```bash
npm run check      # node --check on every backend + frontend JS file
npm run smoke      # 74 API checks: auth, watch validation, deposits, payouts, admin, isolation
npm run smoke:ui   # renders every screen in headless Chrome and checks the spec'd content
```

`npm run smoke` drives a real server on an isolated store and asserts, among other
things: a reward is refused before the watch requirement is met, a deposit stays
Pending without a verified provider result, replaying a callback credits nothing twice,
an admin cannot complete a payout, revoked sessions lose access, one user cannot read
another's wallet, and no "guaranteed returns" claim or provider credential exists in
the frontend bundle.

## API overview

```
GET  /api/public/config|health
POST /api/auth/register|login|logout|forgot-password|reset-password|change-password|logout-all
GET  /api/auth/me|profile|payout|sessions      PUT /api/auth/profile
POST /api/auth/phone|payout                    # both require the account password
GET  /api/home/summary
GET  /api/watch/videos|rewards|history
POST /api/watch/sessions · /api/watch/sessions/:id/progress|claim
GET  /api/wallet/summary|config|transactions|deposits/:id|withdrawals
POST /api/wallet/deposit|withdraw|withdraw/quote
GET  /api/team
GET  /api/notifications · POST /api/notifications/:id/read|read-all
POST /api/mpesa/callback                       # provider webhook (idempotent)
POST /api/mpesa/sandbox/callback               # development only, refused in production
Admin: /api/admin/overview|users|videos|deposits|withdrawals|rewards|referrals|notifications|settings|audit-logs
WebSocket: ws(s)://host/ws?token=JWT
```

## Security

bcrypt password hashing · JWT in an httpOnly cookie with revocable sessions · double-submit
CSRF guard · rate limiting · helmet + CSP · parameterised SQL · per-user data isolation ·
masked phone numbers in every response · password re-authentication for phone/payout
changes.

## Deployment

See `DEPLOY-RAILWAY.md`, `render.yaml` (Render blueprint) and `vercel.json`.
`GET /api/public/health` reports which payment provider is active — if it says
`unconfigured`, deposits are intentionally disabled.
