# Deploy WATCHREWARDS to Railway

1. Push this repo to GitHub.
2. railway.app → New Project → Deploy from GitHub repo.
3. Add a **PostgreSQL** plugin (or use Supabase — set `DATABASE_URL`).
4. Set variables (Railway → Variables):

   ```
   NODE_ENV=production
   APP_URL=https://<your-app>.up.railway.app
   DATABASE_URL=postgresql://...        (Railway Postgres or Supabase pooled string)
   DATABASE_SSL=true
   JWT_SECRET=<long random>
   CSRF_SECRET=<long random>
   ADMIN_EMAIL=...
   ADMIN_PASSWORD=...
   ADMIN_PHONE=...

   # Payments — leave empty only if you do not want to take real money yet.
   # With no live credentials the payment layer refuses deposits/payouts instead
   # of faking them, and the sandbox simulator is disabled in production.
   PAYMENT_PROVIDER=mpesa
   PAYMENT_MODE=live
   MPESA_ENV=production
   MPESA_APP_KEY=<Daraja consumer key>
   MPESA_APP_SECRET=<Daraja consumer secret>
   MPESA_SHORTCODE=<paybill / till>
   MPESA_PASSKEY=<lipa na mpesa passkey>
   MPESA_CALLBACK_URL=https://<your-app>.up.railway.app/api/mpesa/callback

   MPESA_B2C_SHORTCODE=<payout shortcode>
   MPESA_B2C_INITIATOR=<initiator name>
   MPESA_B2C_SECURITY_CREDENTIAL=<encrypted credential from Daraja>
   ```

5. Deploy, then run the seed once (Railway → service → “…” → Run command):
   `npm run seed`

The single service hosts both the API and the mobile frontend, so no separate
hosting is required. Railway/Render are recommended over serverless platforms
because the notification feed uses WebSockets.

## Before going live

- `GET /api/public/health` should report the payments provider as
  `mpesa` / `live`. If it reports `unconfigured`, deposits are disabled.
- Confirm the Daraja callback URL matches `MPESA_CALLBACK_URL` exactly — that is
  the only place a deposit is allowed to become `successful`.
- Run `npm run smoke` (API acceptance checks) and `npm run smoke:ui`
  (real screens in headless Chrome) against a staging environment.
