# Deploy to Railway
1. Push this repo to GitHub.
2. railway.app → New Project → Deploy from GitHub repo.
3. Add a **PostgreSQL** plugin (or use Supabase — set DATABASE_URL).
4. Set variables (Railway → Variables):

   NODE_ENV=production
   APP_URL=https://<your-app>.up.railway.app
   DATABASE_URL=postgresql://...   (from Railway Postgres or Supabase)
   DATABASE_SSL=true
   JWT_SECRET=<long random>
   CSRF_SECRET=<long random>
   ADMIN_EMAIL=...
   ADMIN_PASSWORD=...
   MPESA_APP_KEY=...            (leave empty for demo mode)
   MPESA_APP_SECRET=...
   MPESA_SHORTCODE=...
   MPESA_PASSKEY=...
   MPESA_CALLBACK_URL=https://<your-app>.up.railway.app/api/mpesa/callback

5. Deploy, then run the seed once (Railway → service → "… " → Run command):
   npm run seed

The app serves both API and frontend on one port — no separate hosting needed.
