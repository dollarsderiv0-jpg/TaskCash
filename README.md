# TaskCash Kenya 🇰🇪

A production-ready **task rewards platform**: users complete sponsored tasks, earn KES, refer friends, deposit & withdraw via **M-Pesa**. Built with Node.js + Express + PostgreSQL/Supabase, vanilla JS + Tailwind-style custom CSS frontend, WebSockets, JWT auth and a full admin panel.

> **Compliance first:** TaskCash is a *rewards* platform, **not an investment scheme**. Earnings come only from completed tasks, referrals, and sponsored activities. There are no guaranteed returns — disclaimers are present across the UI, and withdrawals pass KYC + anti-fraud review.

---

## ✨ Features

| Area | Highlights |
|---|---|
| **Auth** | Register (all required fields + referral capture), login, email verification, forgot/reset password, change password, profile, KYC account verification |
| **Tasks** | 8 categories (video, social, survey, website, affiliate, app, referral, check-in) · 4 verification methods (code, screenshot, manual, auto) · daily caps by package · anti-fraud (duplicate/IP/UA guards) |
| **Video tasks** | Embedded player, countdown timer, server-side watch-session verification, instant reward |
| **Wallet** | M-Pesa STK Push deposits (live Daraja + demo simulator), balance polling, deposit/withdrawal history, 2% withdrawal fee, daily limits, min KES 100 |
| **Withdrawals** | M-Pesa & bank, KYC-gated, admin approve/reject workflow, funds held in pending balance |
| **Referrals** | Unique links/codes, 2 levels (10% / 3%), team dashboard, instant commissions on task approval |
| **Packages** | Starter 500 / Silver 1,000 / Gold 2,500 / Platinum 5,000 — unlock higher daily task limits |
| **Notifications** | WebSocket real-time toasts + drawer, deposits/withdrawals/task approvals/referrals/promos |
| **Admin** | Analytics (Chart.js: deposits, withdrawals, user growth, task completions), users (suspend/adjust), KYC review, withdrawal & deposit approvals, task CRUD, packages, promos, announcements, tickets, broadcasts |
| **Extras** | Leaderboard, daily check-in streaks, achievement badges, promo codes, support tickets, live chat, announcement center, PWA + offline shell, dark/light mode |

## 🚀 Quickstart

```bash
npm install
cp .env.example .env      # fill in values (or leave defaults for demo)
npm run seed              # creates admin, demo users, packages, 11 tasks, promos
npm run dev               # http://localhost:3000
```

**Demo logins** (after seed):
- User — `wanjiku` / `Demo@1234`
- Admin — `admin@taskcash.co.ke` / `Admin@1234`

**Zero-infrastructure mode:** with no `DATABASE_URL`, the app auto-falls back to a JSON file store (`data/db.json`) so you can demo everything locally. Set `DATABASE_URL` to any PostgreSQL (Supabase pooled string works) for production; `schema.sql` is applied automatically at boot.

## 📲 M-Pesa setup (Daraja)

1. Create an app at [developer.safaricom.co.ke](https://developer.safaricom.co.ke) → get Consumer Key/Secret.
2. Use the sandbox shortcode `174379` + the public sandbox passkey for testing.
3. Set in `.env`:
   ```
   MPESA_APP_KEY=...
   MPESA_APP_SECRET=...
   MPESA_SHORTCODE=174379
   MPESA_PASSKEY=...
   MPESA_CALLBACK_URL=https://your-domain.com/api/mpesa/callback
   ```
4. For local testing expose the server (ngrok/cloudflared) and set `MPESA_BASE_URL` to the public URL.
5. **No keys set = demo mode**: STK pushes are simulated and the callback auto-fires after ~8s so the full UX is testable.

Withdrawal payouts (B2C) are marked by an admin after the transfer is made from the platform wallet; the B2C API hook point is annotated in `backend/routes/admin.js`.

## 🔐 Security

- bcrypt (12 rounds) password hashing
- JWT (httpOnly cookie + Bearer support) with role-based access control (`user` / `admin`)
- **Strict CSRF**: double-submit cookie + HMAC-signed token on every state-changing API call
- Rate limiting (auth + global), helmet security headers + CSP, CORS allowlist
- Parameterized SQL (no string-built queries), XSS-escaped rendering, JSON body limits
- Anti-fraud: duplicate-submission guards, IP/UA capture on submissions, manual review queue, KYC gate before withdrawals

## 🗄 Database

PostgreSQL schema in `backend/db/schema.sql` (users, packages, tasks, task_completions, deposits, withdrawals, referrals, notifications, email_tokens, promo_codes, achievements, support tickets, announcements, app_settings, earnings feed, chat). Applied automatically at boot; Supabase-compatible.

## 📡 API overview

```
POST /api/auth/register|login|logout|forgot-password|reset-password|change-password
GET  /api/auth/me|verify-email  ·  PUT /api/auth/profile  ·  POST /api/auth/kyc
GET  /api/stats|history|feed|leaderboard   POST /api/checkin
GET  /api/admin/analytics                  (admin)
GET  /api/tasks  ·  POST /api/tasks/:id/submit|video-verify  ·  GET /api/tasks/mine
POST /api/wallet/deposit|withdraw  ·  GET /api/wallet/deposits|withdrawals
GET  /api/wallet/packages  ·  POST /api/wallet/packages/:id/purchase
POST /api/wallet/promo/redeem
GET  /api/notifications|referrals|tickets|announcements|chat
POST /api/mpesa/callback               (Daraja webhook)
Admin: /api/admin/users|withdrawals|deposits|tasks|completions|kyc|packages|promos|announcements|broadcast
WebSocket: ws(s)://host/ws?token=JWT   (notifications, live feed, chat, admin alerts)
```

## ☁️ Deployment

- **Railway** — see `DEPLOY-RAILWAY.md` (single service hosts API + frontend).
- **Render** — `render.yaml` blueprint included.
- **Vercel** — `vercel.json` included (Node server). Note: WebSockets need a platform that supports them; Railway/Render are recommended for the full real-time experience.
- **Frontend on Vercel + API on Railway**: set `CORS_ORIGINS` on the backend to the Vercel domain; the frontend talks to the API same-origin only if proxied — the included setup is single-origin and simplest.

### Environment variables
See `.env.example` — every variable is documented there (server, security, database, admin bootstrap, M-Pesa, SMTP).

## 🧪 Verification checklist

- `npm run check` — syntax-checks every JS file
- Register → deposit (demo STK) → complete task → request withdrawal → approve in admin
- Referral: register with a user's code, approve their task, check L1 commission

## ⚠️ Disclaimers & responsible operation

- No guaranteed returns anywhere in the product; packages unlock task capacity, they do not "pay out".
- Earnings derive solely from verified task completion, referral commissions on real activity, promos and bonuses.
- Operators are responsible for complying with local regulations (Kenya: confirm current CBK/ODPC & gambling-vs-rewards guidance), data protection, and tax obligations.
- The M-Pesa integration includes STK Push (C2B) live-ready; B2C payouts are admin-triggered pending your Daraja production credentials.
