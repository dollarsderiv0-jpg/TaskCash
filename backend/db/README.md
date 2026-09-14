# Database layer

`backend/db/index.js` exports a two-mode adapter:

- **pg mode** — PostgreSQL / Supabase. `schema.sql` is applied automatically at
  server boot. Set `DATABASE_URL` (Supabase pooled connection string works) and
  `DATABASE_SSL=true` for hosted providers.
- **json mode** — file-backed fallback in `data/db.json` so the app boots with
  zero infrastructure (local demo). Subset semantics, same interface.

All tables are accessed via `new Table('name')` helpers
(`all/get/byId/create/update/adjust/delete/count/sum`) plus
`timeSeries`/`dailyCounts` aggregates for charts. Route code never branches on
the mode.
