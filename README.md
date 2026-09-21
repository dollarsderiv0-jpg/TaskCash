# TaskCash Pro

A real-money rewards platform. Users complete eligible sponsored video campaigns and approved
tasks, accumulate rewards in an internal wallet ledger, invite qualifying users through a referral
program, and request withdrawals to a mobile-money destination. **Every withdrawal is reviewed by
an administrator before payment is sent.**

---

## What this is not

Stated plainly, because it matters:

- Not a bank, not a licensed PSP, not an investment manager, not a securities platform.
- No guaranteed returns, no fixed daily income, no interest or profit on deposits.
- No fake balances, no fake payment confirmations, no auto-approved withdrawals.
- No fabricated statistics, testimonials or regulatory claims anywhere in the UI.

Platform identity (legal entity, registration details, support contacts) ships **empty** on purpose.
Fill it in at **Admin → Settings → legal** before launch. The public site says so rather than
inventing a company.

---

## Architecture

```
Browser ──► Next.js App Router (Vercel)
API client ─┘  ├─ Server Components read via RLS-scoped Supabase client
              │  ├─ /api/* route handlers: authenticate → validate (Zod) → act
              │  └─ Server-only service layer (src/server/services)
              ▼
        Supabase Postgres
          ├─ Immutable ledger (wallet_transactions)
          ├─ SECURITY DEFINER money functions (atomic, idempotent)
          └─ Row Level Security: SELECT own rows only
              ▼
        Payment gateway (selected by PAYMENTS_PROVIDER)
          ├─ PayHero                    (ACTIVE: STK Push in, mobile payouts out)
          ├─ M-Pesa / Safaricom Daraja  (retained, still works)
          └─ SasaPay                    (retained, still works)
```

### Payments

Which gateway the money paths use is **configuration, not code**: every financial service calls
`src/lib/payments/provider.ts`, and that facade reaches PayHero, M-Pesa (Daraja) or SasaPay according
to `PAYMENTS_PROVIDER`. Nothing in the deposit or withdrawal services names a provider, so the
settlement, idempotency and audit behaviour is identical whichever one is selected.

`PAYMENTS_PROVIDER` resolves in this order: an explicit value wins; then **PayHero if its credentials
are present** (so adding the API keys is all it takes to activate it); then M-Pesa. A deployment with
no payment credentials therefore reports "M-Pesa is not configured" rather than silently reaching for
a provider nobody set up. `GET /api/health` reports which provider resolved and why.

The invariant that makes a payment impossible to fake is the same in both integrations: **an
accepted request is not a payment.**

| Direction | What is accepted | What settles it |
| --- | --- | --- |
| Deposit | STK Push returns `ResponseCode: 0` — the customer was *prompted* | An STK status query reporting paid **and** an amount matching the deposit, read from the callback metadata |
| Withdrawal | B2C returns a `ConversationID` | The B2C result on our own `ResultURL`, **authenticity-verified**, with a matching amount |

Daraja has no synchronous B2C status call, so for payouts the result callback is the only evidence —
which is why an unverified one is recorded and **not acted on**: the funds stay held and the
withdrawal waits for an operator. A queue timeout settles nothing, for the same reason. There is no
M-Pesa simulator; a fabricated payout would be indistinguishable from a real one in the ledger.

### Authentication

Three Supabase clients, three jobs, and no overlap:

| Module | Credential | Purpose |
| --- | --- | --- |
| `src/lib/supabase/client.ts` | publishable key | browser only |
| `src/lib/supabase/server.ts` | cookie session **or** the caller's bearer token | every user-scoped read and write, under RLS |
| `src/lib/supabase/admin.ts` | secret key | service-role operations that have already authorised the caller themselves |

`server.ts` is the one that matters for correctness. It attaches whichever credential the caller
presented, so a query is always evaluated as that caller — the key stays the *publishable* one, and
the token can only narrow access, never widen it. Carrying the token centrally (rather than in each
route) is deliberate: services like `getWalletOverview` build their own client, and a bearer request
used to arrive with no credential at all, so the query matched nothing and the endpoint answered
`200` with a null balance. A balance that is silently absent is worse than one that errors.

Bearer support is provided by `@supabase/server` (`createSupabaseContext`), which verifies the JWT
against `SUPABASE_JWKS_URL` — configured, signature-verified, and now actually used. Without that
variable the auth service does the verifying instead, so the feature degrades to a network call
rather than to no verification.

```bash
npm run test:bearer      # 27 checks: real tokens, real routes, forged tokens, isolation
npm run test:e2e         # 63 checks; 12 of them cover the Bearer path
npm run test:nonadmin    # 48 checks: a plain USER is refused every admin surface
npm run test:sweep       # every page and API route, in three caller states
```

### The money rule

`wallets.available_balance` / `locked_balance` are **only ever** written by
`public.wallet_post()` — the single ledger choke point. It:

1. serialises on the reference (`pg_advisory_xact_lock`),
2. returns the existing row if that reference already posted (idempotent),
3. locks the wallet row (`FOR UPDATE`),
4. refuses to go negative,
5. writes an immutable `wallet_transactions` row with the signed effect on each balance bucket.

Every higher-level operation (`deposit_credit`, `withdrawal_reserve`, `withdrawal_release`,
`withdrawal_complete`, `video_complete_session`, `referral_credit`, `admin_adjust_wallet`) is a
single Postgres function, so a financial event either happens completely or not at all.
The ledger is append-only: an UPDATE/DELETE trigger rejects any attempt to modify history.

Four invariants are enforced *in the database*, not by convention:

- **No payout without approval.** `withdrawal_complete` raises `WITHDRAWAL_NOT_APPROVED` unless an
  administrator's approval is already on the record. No code path can pay an unreviewed request.
- **A reference belongs to one account.** A `wallet_post` reference that resolves to a different
  user is a collision, not a replay, and raises instead of silently swallowing the movement.
- **A campaign cannot overspend.** Completion locks the campaign row before checking the budget,
  and rolls the whole reward back if the ceiling cannot cover it.
- **A hold always resolves.** The withdrawal hold is `+amount` locked, then `-net` and `-fee` —
  exactly zero — so the fee is never charged twice and never stranded in `locked`.

### Money movements

| Action | Balance effect | Reference |
| --- | --- | --- |
| Deposit confirmed by provider | available `+amount` | `DEP-<deposit id>` |
| Video reward verified | available `+reward` | `VRW-<session id>` |
| Referral commission | available `+commission` | `RCM-<referrer>-<level>-<source tx>` |
| Withdrawal requested | available `-amount`, locked `+amount` | `WHL-<withdrawal id>` |
| Withdrawal released (rejected/failed) | locked `-amount`, available `+amount` | `WRL-<withdrawal id>` |
| Payout confirmed by provider | locked `-net`, then locked `-fee` (both draw on the hold, which nets to zero) | `WDR-<withdrawal id>` / `WDF-<withdrawal id>` |

| Admin adjustment | available `±amount` (signed) | `ADJ-<uuid>` |

### Video sources

A catalogued video is either a direct file (played in `<video>`) or a YouTube link (played in the
provider's own `<iframe>` embed). Which one is needed is derived from the stored URL itself
(`src/lib/video/source.ts`), so there is no extra column to keep in sync and no backfill — and a link
pasted into `/admin/videos` just works. A YouTube URL that is not a single video (a channel, a search)
is refused by the admin form rather than saved as a row that cannot play.

The embed is never trusted for anything. A session completes on elapsed time the **server** observed,
not on anything the embedded player reports, so a third-party video cannot shorten a required watch
time. Verify a catalogue's YouTube ids are still playable with `npm run test:youtube`.

### Collecting a reward

After the required watch time the user presses **Collect reward**. The session does not complete itself,
and nothing about verification changed: the server re-checks the watch time *it* observed and decides the
reward, which is read from the video row and never from the client.

Five defects on this path were found by running it, and are now fixed (details and evidence in
`.freebuff/run.md` §5b-duodecies):

1. **The client's progress report never fired** — `elapsed` was in the effect's dependency array, so the
   report interval (10s at the time) was re-created every second (measured: **0** progress requests). Fixed
   with a ref, plus a final report before collecting.
2. **`public.video_progress()` raised `42702` on every call** — it referenced `watched_seconds`, which is
   also the name of one of its own OUT parameters, so Postgres could not tell them apart. The function had
   never worked; fixing (1) exposed it. Fixed in `0011`.
3. **A zero-reward video could not complete** — `wallet_post` rejects a non-positive `VIDEO_REWARD`, so a
   campaign that shows content without paying for it was impossible. `0010` adds a `NO_REWARD` branch
   placed after every gate; it writes no ledger row and touches no balance.
4. **A frozen local countdown locked users out of a reward the server had granted** — the button unlocked
   on the local timer *and* the server, but browsers throttle timers in a backgrounded tab, behind a locked
   phone and in a minimised window. The server's verdict now decides on its own; the local clock is only
   display.
5. **The 3-second confirmation poll had the same dependency bug as (1)** — invisible while the demo
   requirement was 60s, because that coincided with the 10-second report. The clock is now read inside the
   interval.

The report interval is no longer a fixed 10 seconds: it is **derived from the requirement** (a third of it,
clamped to 2–10s). At the current 10-second requirement a fixed 10-second report would land exactly on the
gate and could miss it by a hair, leaving the first useful update up to twice as late as needed — and
because a shortfall is terminal, "late" is the difference between a reward and a rejected session.

Underneath all five sits one trap worth knowing: `video_complete_session` treats a watch-time shortfall as
**terminal and punitive** — it marks the session `REJECTED` and files a `WATCH_TIME_MISMATCH` fraud event. A
collect that arrives one second early therefore does not merely fail, it destroys the session and penalises
an honest user. So the UI will not ask for a reward the server has not confirmed, and
`completeVideoSession()` re-reports the server's own elapsed time immediately before calling the RPC (the
database clamps any claim to `elapsed + 1.5`, so this cannot invent watch time either).

`npm run test:zero-reward` verifies the database behaviour on a real Postgres, including that a **paying**
video still credits the wallet and that the re-declared function loses no line from the original. The
end-to-end earn path is `npm run test:earn`.

### Building a large catalogue: `npm run videos:ingest`

`scripts/ingest-youtube-trailers.mjs` harvests ids from official studio channels, proves each is
embeddable, and inserts the survivors:

```bash
npm run videos:ingest -- --limit 400 --per-channel 60 --concurrency 8 --reward=2 --budget=4000 --visible
npm run videos:ingest -- --dry-run --limit 30     # harvest + verify, write nothing
npm run videos:ingest -- --remove                 # delete the campaign it made
```

A catalogue cannot be generated. A video id that 404s is worse than no row at all, because the row carries a
`reward_amount` — a dead player is a payout promise — so each id must pass **two** signals: oEmbed 200 and
`playabilityStatus: OK` with `playableInEmbed: true` from the watch page. oEmbed alone passed all 700 ids of
one throttled run, which is exactly why one is not enough.

The ceiling is the cost of proof, not the database: ~2 requests and ~1MB per video (~2M calls for a million),
plus a Data API key for discovery. `--limit` is the honest dial. Unverified ids are never written, so a later
run picks them up; YouTube throttles after a few hundred watch pages with **HTTP 429**, and both this script
and `test:youtube` now report that as `UNVERIFIED` rather than "do not seed".

Every clip is credited to the channel that published it, and the campaign's `advertiser` states that it is a
house campaign — no studio sponsored those views.

### M-Pesa production (`MPESA_ENV=production`)

`MPESA_ENV=production` sends every call to `https://api.safaricom.co.ke` — the host is derived from that one
variable, and a production build refuses the sandbox (`mpesa/config.ts`). Set the credentials with the
masked prompt; `--config` is allowlisted to non-secret settings only:

```bash
npm run env:set                                                       # masked, never echoed
npm run env:set -- --config MPESA_ENV=production
npm run test:mpesa:production                                         # 23 checks, needs no credentials
npm run test:mpesa:config                                             # 25 checks — which host, and no leaks
```

`MPESA_BASE_URL` is read too, because deployment templates carry it, but it is an **assertion and not an
override**: it must name one of Safaricom's two hosts *and* agree with `MPESA_ENV`, or the call fails
with the variable to change. A third-party host is refused outright — that is where the Consumer Key and
Secret would be sent. Leave it commented out (as `.env.example` does) and switching `MPESA_ENV` can never
leave a stale URL behind. `GET /api/health` reports `payments.baseUrl` and
`payments.configurationError` (a variable name, never a value).

Callback URLs must be your deployed domain and end with the route that exists —
`/api/payments/mpesa/callback`, `/api/payments/mpesa/b2c/result`, `/api/payments/mpesa/b2c/timeout`. A URL
registered at the wrong path is accepted by Safaricom, delivers nothing, and looks exactly like "the
customer never paid" with the money already gone from their phone.

While credentials are absent the platform **fails closed, and says so honestly**: a deposit answers
`503 PAYMENT_NOT_CONFIGURED` and creates no deposit row; an approved withdrawal stays APPROVED with funds
held (not paid, not failed, hold not released); a forged "payment succeeded" callback credits nothing and
leaves the deposit PENDING, because only Safaricom's own status may settle it. Nothing here substitutes a
sandbox response, simulated callback or fake receipt — the M-Pesa provider has no simulator at all.

**`0008`, `0009` and `0012` are still waiting to be applied to the live project** (paste
`supabase/apply-all.sql` into the SQL editor, or set `DATABASE_URL`/`SUPABASE_ACCESS_TOKEN` and run
`npm run db:push-sql`). `npm run verify:remote` is the authority; last checked it reported `0010` and
`0011` as applied and these outstanding:

- **`0012` (deposit provider identifiers)** — `deposits` gains `merchant_request_id`, `result_code`,
  `result_description`, `updated_at`, plus `checkout_request_id` and `mpesa_receipt_number` as columns
  **generated** from the references already stored. Nothing financial changes and no payment breaks
  without it: the service records the provider's own result/description when it can and logs a warning
  when the columns are absent. Until it is applied, a failed M-Pesa payment cannot be explained from the
  row alone — you would have to open the `callback_payload` jsonb.

- **`0009` (advertisements)** — no gallery. `/dashboard/ads` degrades honestly ("This section is being set
  up") instead of erroring, and `/admin/ads` names the missing migration, so nothing crashes; but no
  advertisement can be shown or published until the table exists.
- **`0008` (rate-limit retry-after)** — `GET /api/rate-limit` cannot report the real remaining wait, so
  `retryAfterSeconds` falls back to the whole window (3600s) rather than the true reset instant. The
  limiter itself still refuses correctly; only the number it quotes is coarse.

### PayHero (the active provider)

PayHero fronts M-Pesa: you call PayHero, and it pushes the STK prompt to the customer. Money settles
into your own PayHero channel (till or paybill) — TaskCash holds no float.

**Where to enter the credentials.** They are server-only secrets and are read at request time, never at
build time. Nothing is echoed and nothing is written to a log:

```bash
npm run env:set -- --only=PAYHERO_API_USERNAME,PAYHERO_API_PASSWORD,PAYHERO_CHANNEL_ID
```

| Variable | Where to get it |
| --- | --- |
| `PAYHERO_API_USERNAME` | PayHero dashboard → **API keys** (https://app.payhero.co.ke) |
| `PAYHERO_API_PASSWORD` | the same page |
| `PAYHERO_CHANNEL_ID` | **Payment Channels → My Payment Channels** — the channel *id* |
| `PAYHERO_CALLBACK_URL` | optional; default is `<APP_URL>/api/payments/payhero/callback` |
| `PAYHERO_CALLBACK_SECRET` / `PAYHERO_CALLBACK_IPS` | optional callback hardening — set one in production |
| `PAYHERO_DEFAULT_NETWORK_CODE` | optional; SasaPay network code used for payouts |

They are sent as HTTP Basic auth on every request. **`PAYHERO_API_URL` defaults to
`https://backend.payhero.co.ke/api/v2` and is refused unless it is a `payhero.co.ke` host** — PayHero
authenticates with a password, so a wrong host is not a failed request, it is the place that password
would be sent. There is no PayHero sandbox host and no simulator.

**The webhook URL to register.** Paste this into the PayHero dashboard (for the channel above), or
payments will never settle:

```
https://<your-domain>/api/payments/payhero/callback
```

`npm run preflight` prints the exact value this deployment will use. If you set
`PAYHERO_CALLBACK_SECRET`, register the URL as `.../callback?token=<secret>`; PayHero's own
`x-payhero-signature` HMAC of the raw body is also accepted.

```bash
npm run preflight               # names any missing variable, by NAME
npm run test:payhero            # 104 checks — auth, host allowlist, retry policy, verdicts, callbacks
npm run test:payhero:deposit    # the deposit path fails closed, and creates no record
```

The rule is the same as every other provider: **an accepted request is not a payment.** PayHero
answers a dispatched prompt with `status: "QUEUED"` and refuses with HTTP 200 and `success: false`, so
the HTTP status alone is never trusted. A deposit is credited only when a status query reports paid
**and** the amount matches; a callback is a hint that triggers that query, never evidence that settles
anything on its own. A payout is never retried, because a retried payout is a duplicated payout.

### Deploying to Render

`render.yaml` is the blueprint: a web service (`npm ci && npm run build`, then `npm start`) with
`healthCheckPath: /api/health`, plus a 10-minute cron calling `/api/cron/reconcile`. The Vercel cron in
`vercel.json` does not exist on Render, and that sweep is not optional — an STK Push whose callback
never arrives (lost signal, a delivery failure) stays PENDING forever while the customer has already
paid. The cron command was executed against a running server rather than assumed, which caught a real
bug: the route exports **GET only**, so a POST version would have returned **405** every ten minutes.

Every credential uses `sync: false`, so Render prompts for it and nothing lands in git — the blueprint
was machine-parsed and asserted to contain no secret with an inline value.

Verified locally against a real production server, not a dev server: the build compiles cleanly,
`npm start` serves on whatever `PORT` is injected (checked with 4180), and the app reports
`NODE_ENV=production` — the flag that makes the sandbox-host refusal and the callback-URL guards
engage. `render.yaml` sets it explicitly anyway, so those guards do not depend on framework behaviour.

Two rules the callback URLs must satisfy, both now covered by `npm run test:mpesa:config`: **HTTPS
only**, and **never localhost in production**. Both fail in the same misleading way — Safaricom simply
never calls back, which looks exactly like "the customer never paid" with the money already gone from
their phone.

### Deploying to Vercel

Live at **https://taskcash-pro.vercel.app** (project `justcallmedavy-3136/taskcash-pro`).

There is no Git integration, because this checkout is not a repository with a remote — so a deploy
uploads the local working tree directly, and uncommitted edits ship:

```bash
npm run deploy:env -- --url https://taskcash-pro.vercel.app   # push env vars; values go over stdin
npx vercel --prod --yes
npm run check:live                                            # 11 read-only checks on the live site
```

`npm run deploy:env` is an allowlist, not a mirror of `.env.local`. That file describes a local
machine — `APP_URL=http://localhost:4177` — and `APP_URL` is what password-reset and confirmation
links are built from, so mirroring it would email customers links to a host that does not exist. Every
URL-shaped variable is derived from `--url` instead, and anything missing is reported as skipped.

Two things had to be declared rather than assumed:

- **`"framework": "nextjs"` in `vercel.json`.** A project created fresh by `vercel link` defaults to
  the `services` preset, and the first build failed with *"Project framework is set to services, but no
  services are declared."*
- **A daily cron, not every 10 minutes.** The account is **Hobby**, and Vercel *rejects the deploy*
  outright for a sub-daily expression: *"Hobby accounts are limited to daily cron jobs."* `vercel.json`
  therefore uses `0 2 * * *`. That is currently harmless — with no M-Pesa credential configured no
  deposit can be initiated, so there is nothing to reconcile — but it becomes money-critical the day
  those variables are set, because the sweep settles an STK Push whose callback never arrived. On
  Hobby, drive it from any external scheduler instead; the route already authenticates on the secret
  that Vercel injects automatically:

  ```bash
  curl -s -H "Authorization: Bearer $CRON_SECRET" https://taskcash-pro.vercel.app/api/cron/reconcile
  ```

`.vercelignore` keeps `.env*` out of the upload, so a localhost value can never reach a build.

### Security posture

- **RLS:** users get `SELECT` on their own rows and nothing else. There is deliberately **no**
  INSERT/UPDATE/DELETE policy on any financial table, so a client cannot set a balance, a reward
  amount, a transaction status, a withdrawal status or a role. Not even a forged request can.
- **Admin:** `/admin` re-reads the caller's role from the database on every request. Visiting the
  route grants nothing.
- **Withdrawals:** `withdrawal_reserve` → admin approval → provider disbursement → provider
  confirmation. A payout is only marked `COMPLETED` once the provider confirms it.
- **Callbacks:** treated as untrusted hints. Every settlement re-asks the provider for the
  authoritative transaction status first. An unconfirmable payment stays `PENDING` and raises a
  reconciliation alert instead of being credited on assumption.
- **Two ways to authenticate, one way to authorise.** The browser uses a session cookie
  (`@supabase/ssr`). A caller that is not a browser — a mobile client, a script, an integration —
  presents `Authorization: Bearer <access token>`, verified through `@supabase/server` against the
  project's JWKS and then by the auth service. Both paths produce the *same* caller-scoped client,
  so RLS decides what either may see; neither ever receives a privileged client. A token that is
  present but invalid is **refused, never downgraded** to the cookie — an expired client cannot ride
  on a browser session that happens to still be open. See `src/lib/supabase/bearer.ts`.
- **Secrets:** `SUPABASE_SECRET_KEY` (or its legacy alias `SUPABASE_SERVICE_ROLE_KEY`),
  `SASAPAY_CLIENT_SECRET` and `AUTH_SECRET` are only read in server-only modules and are never
  behind a `NEXT_PUBLIC_` prefix.
- **Identifiers:** IPs and device ids are stored as keyed HMACs only.
- **Rate limiting:** database-backed (serverless-safe), fail-closed for auth and withdrawals.
- **Failure honesty:** a deployment fault is never disguised as a transient one. Missing
  credentials produce `503 PLATFORM_NOT_CONFIGURED`; credentials that work but a schema that was
  never applied produce `503 PLATFORM_NOT_MIGRATED`. Neither says "try again", because no retry can
  fix either. Every response carries a `requestId` that appears in the structured log.

### Anti-fraud

Signals (velocity, device spread, referral concentration, deposit-to-earning ratio, withdrawal
velocity, duplicate accounts per IP) accumulate into a risk score. A score places an account in the
**review queue** — a single weak signal never bans anyone. Restriction and suspension are explicit,
audited administrator actions.

### Support tickets

Users reach a human about money through `/support` — searchable help, the live platform limits
(withdrawal minimum, fee, daily limit), contact channels, and a request form. Requests become
tickets (`support_tickets` + `support_messages`, migration `0006`) with a short quotable reference
like `TCS-4K2M8P`.

`OPEN → IN_REVIEW → RESOLVED → CLOSED`. A reply from the user reopens a **resolved** ticket, because
they clearly still need help; a **closed** one is final. As with every other table, the browser has
SELECT on its own rows and no INSERT/UPDATE policy at all — tickets are created and replied to
through SECURITY DEFINER functions that take the owner from `auth.uid()`, never from a parameter.
The support tables are optional: without `0006` the page still helps, and only the form is withheld.

Administrators work the queue at `/admin/support` (reply, pick up, answer, close). The acting
administrator is resolved inside the database by `support_admin_reply` (migration `0007`) and the
role is re-checked there, so a mis-wired route cannot answer as an admin. Each reply writes an audit
record and notifies the user in the same transaction — a reply cannot exist without the user being
told. Status and message are independently optional, so a ticket can be picked up or closed without
inventing a message.

---

### Advertisements (display only)

A sponsored gallery of advertiser-supplied pictures — company-registration services, deposit and
withdrawal services — at `/dashboard/ads`, managed by an administrator at `/admin/ads`.

Viewing an advertisement **pays nobody**. There is no budget, no watch session, no reward column and
no ledger entry, and the type has no shape for money on purpose. The paid path is Videos & campaigns;
this deliberately does not duplicate it. Both the page and the admin screen say so in plain words,
because a picture sitting in a row of earning buttons otherwise implies an earning that will never
arrive.

Visibility is a property of the row, not of a query: a picture is readable only while its status is
`ACTIVE` and the current time is inside its schedule window, so pausing one or letting it expire takes
effect everywhere at once. The browser has `SELECT` on live rows and no write policy whatsoever; every
change goes through `/api/admin/ads` with the service role and lands in `audit_logs`.

If migration `0009` has not been applied, the gallery says it is being set up rather than rendering as
an innocent empty list, and the admin screen names the missing migration. `npm run test:ads-schema`
checks all of this against a real Postgres without needing credentials.

### Writing for the user, not the database

Raw status codes never reach a person's screen. `PENDING_ADMIN_APPROVAL` renders as **“Waiting for
review”**, `PROCESSING` as **“Payment being processed”**, `FAILED` as **“Payment couldn't be
completed”**. The map lives in one place (`src/lib/types.ts`) and is shared with the admin screens
on purpose — those phrases are still precise enough for staff, and two label sets would drift apart
until one of them was wrong.

Handlers raise tokens (`INSUFFICIENT_AVAILABLE_BALANCE`) that map to sentences plus a `requestId`
(`src/lib/api/errors.ts`); raw provider and Postgres text stays in the structured log. Balances are
never rendered optimistically — they are re-read from the server after any credit.

---

## Getting started

```bash
npm install
cp .env.example .env.local     # then fill it in
```

### 1. Create the database schema

Use a **dedicated** Supabase project. Put its connection string (Session pooler or direct — not
the transaction pooler) in `.env.local` as `DATABASE_URL`, then:

```bash
npm run db:migrate:dry     # show what would run, change nothing
npm run db:migrate         # apply in order, each file transactional + idempotent
npm run db:verify          # read-only check of tables, RLS, policies, grants, seeds
```

The runner records each migration with a SHA-256 checksum and skips what is already applied, so
running it twice is a no-op. If an applied migration's contents changed, it refuses to continue
rather than silently diverging from the database. A failed migration rolls back completely.

`db:verify` asserts the properties that make the money safe — RLS on every table, **no
client-writable policy on any financial table**, an immutability trigger on the ledger, unique
ledger references, money functions that are `SECURITY DEFINER` with a pinned `search_path`, and the
absence of `EXECUTE` for `anon`/`authenticated`. It exits non-zero on failure, so it can gate a
deploy.

Alternatively apply the files by hand in the Supabase SQL editor, or with `supabase db push`.

`DATABASE_URL` needs the database password. If you cannot get it, `npm run db:bundle` writes every
migration into one paste-ready `supabase/apply-all.sql` for the SQL editor. The bundle is
deterministic and carries no transaction control of its own, so one paste is one all-or-nothing
transaction. That path still gives up the per-file checksum record, so treat it as the fallback.

Either way, verify what landed:

```bash
npm run verify:remote   # HTTP only — no database password needed
```

It checks that every required table exists, that the rate-limit function exists **and actually
behaves**, that seeds are present, and that an anonymous client can read no financial table and
cannot write one. It states plainly which properties it cannot see over REST (trigger bodies,
constraint definitions, catalog grants) instead of implying it covered them.

If the project instead holds an **earlier generation** of this schema, `create table if not exists`
cannot repair it — matching table names are skipped and the old columns survive, so later migrations
fail on columns that were never added. `verify:remote` names this per migration file. The fix is one
guarded paste:

```bash
npm run db:reinit      # supabase/reinit.sql = reset + the full bundle, in one transaction
```

It refuses to run at all if the project holds an auth account or a user row, so it cannot reset a
populated database by accident. Read `supabase/reset-incompatible-schema.sql` first.

That file is 2,758 lines, and pasting it by hand is fragile — copying anything else replaces the
clipboard, so what reaches the SQL editor is not the SQL. Send it over HTTPS instead:

```bash
npm run env:set            # one-time: SUPABASE_ACCESS_TOKEN (personal access token, database_write)
npm run db:push-sql        # POSTs supabase/reinit.sql to api.supabase.com — no clipboard, no browser
npm run verify:remote
```

The token is tooling only — nothing in `src/` reads it, `preflight` does not require it, and the app
runs without it. It is account-wide, so delete it when you are done.

## Email verification

**Registration does not send a confirmation email, and none is required.** Signing up creates the
account pre-confirmed with the service role and signs the user straight in, so the flow never depends
on mail delivery — see the reasoning in `src/app/api/auth/register/route.ts`. The trade-off is
explicit there too: no proof of address ownership is collected, so the registration rate limiter is
the only brake on automated sign-ups.

Password reset, and changing an email address, **do** send email, so delivery still matters. Supabase
Auth sends those, and delivery is configured on the project rather than in this codebase. With no
custom SMTP it falls back to Supabase's own mail service, which allows **about two auth emails per
hour** — a password reset at the wrong moment then fails with a message that looks like an
application bug and is not one. Configure custom SMTP before relying on either.

```bash
npm run smtp:configure -- --dry-run   # shows what would be sent; password as a length only
npm run smtp:configure                # SMTP settings + the branded emails/*.html templates
npm run smtp:configure -- --check     # proves what the project is using
npm run preflight -- --production     # fails while SMTP is unset
```

Any transactional provider works — Resend, Postmark, Brevo, Mailgun, SES, SendGrid — because these
are ordinary SMTP settings. `SMTP_FROM_EMAIL` must be on a domain you have verified with the
provider. Nothing in `src/` reads these variables.

Verification is required (`mailer_autoconfirm = false`). Unverified accounts can browse their
dashboard but cannot deposit, withdraw, watch-and-earn or use referrals — enforced server-side on both
the page and the API, with `/verify-email` offering a resend and an email change. An unconfirmed
account is also refused sign-in with a message that says so, rather than one blaming the password.

| File | Contents |
| --- | --- |
| `0001_schema.sql` | tables, constraints, indexes, derived wallet totals view |
| `0002_ledger_functions.sql` | `wallet_post` and the deposit/withdrawal lifecycle functions |
| `0003_rewards_referrals.sql` | user provisioning, video rewards, referral commissions |
| `0004_rls.sql` | row level security, ledger immutability, function grants |
| `0005_seed_settings.sql` | currencies and every admin-configurable business rule |

The two server secrets are easier to set with the masked prompt than by hand:

```bash
npm run env:set              # masked input, writes .env.local in place
npm run preflight            # [PASS]/[FAIL] per variable, grouped; never prints a value
```

`preflight` checks shapes, not just presence, and groups what it reports the way the failures behave:
public configuration, server secret configuration, and database configuration. It rejects a
publishable key in the secret-key slot, a secret key behind a `NEXT_PUBLIC_` prefix, the
`[YOUR-PASSWORD]` placeholder, a password whose reserved characters are not percent-encoded, and the
transaction pooler (port 6543), which cannot run these migrations.

A secret key that has been shared in plain text — pasted into a chat, a ticket, or a log — is
compromised, because it bypasses RLS. Create a replacement in the dashboard, run `npm run env:set`
with the new value, then delete the old key. Never reuse the exposed one.

This is enforced rather than remembered: `scripts/lib/compromised-keys.mjs` stores SHA-256
*fingerprints* of keys known to have leaked, `npm run preflight` fails while a configured key matches
one, and `npm run env:set` refuses to write one back. Rotating clears it automatically; editing the
fingerprint list does not.

### 2. Promote your administrator

Registration never creates an admin. Do this once, manually, after signing up:

```sql
update public.profiles
   set role = 'SUPER_ADMIN'
 where email = 'owner@yourdomain.com';
```

### 3. Run

```bash
npm run backend:setup   # preflight -> migrate -> verify -> money suite
npm run dev             # http://localhost:4177 in this workspace
npm run typecheck
npm run build           # STOP the dev server first — see .freebuff/run.md
```

`backend:setup` is the one command to bring a configured `.env.local` to a verified backend. It
stops at the first failing step and reports which one, so it cannot leave a half-applied schema
looking finished.

---

### End to end

```bash
npm run test:e2e        # registration → login → wallet, plus the authorization boundaries
```

The SQL suite proves the money rules; this proves the routes expose them correctly. It registers two
accounts, asserts auth user → profile → referral code → wallet at exactly `KES 0.00` with no invented
ledger entry, signs in, and then tries to break in: reading another user's wallet, inserting a forged
ledger row, settling a withdrawal, promoting itself to admin, calling the admin approval route
without the role, and influencing a reward amount. Every attempt must fail. It deletes its own
accounts afterwards and refuses to run unless `APP_URL` is loopback, so it cannot touch a deployment.

### Rate limits

```bash
npm run test:rate-limit    # 14 checks against a running app
npm run test:classifier    # 21 checks: which provider failure is which
```

Counters live in Postgres (`public.rate_limits`), because serverless instances do not share memory.
The caller is identified by a keyed HMAC of the client address — never the raw address — which means
**one address is one budget**, shared by everything behind it. A developer machine, an office NAT or a
mobile carrier is a single caller. Production registration therefore allows 5 per address per hour,
and the development build allows 50, chosen from `NODE_ENV` on the server; no header, cookie or query
parameter can influence it.

A refusal states the wait it is actually asking for, taken from the database that owns the window:
`429 RATE_LIMITED` with `retryAfterSeconds`, a `Retry-After` header, and a message naming the action
("too many registration attempts…"), which the register form renders as a live countdown that
re-enables itself when the window rolls over. Refused attempts still increment the counter, so
retrying never shortens the wait — saying "wait a moment" when the truth is 40 minutes teaches a user
to do the one thing that cannot work.

The two things that *look* like "too many attempts" are kept apart on purpose: the app's limiter
(`429`) and the mail service's quota (`503 EMAIL_PROVIDER_ERROR`, sent by `src/lib/auth/provider-errors.ts`).
They used to share one message, which made a bug report impossible to act on. `.freebuff/run.md` §5c has
the full bucket table, the identifier rules, and how to inspect a live counter.

## Testing the money

The money rules are enforced in the database, so they are tested *as* the database:

```bash
npm run test:money:local          # in-process Postgres — no server, no Docker, no credentials
npm run test:money                # scratch database, created and dropped
npm run test:money:transaction    # fallback: rolled back in place
npm run test:money -- --keep      # leave the scratch database for inspection
```

The suite applies the **real migrations** to a throwaway database and runs 182 assertions written
in SQL (`tests/sql/`). Nothing is mocked: it drives the actual functions and reads the actual
ledger. A green run is the evidence that the ledger rules hold — the migrations themselves have
executed against Postgres 18 via `test:money:local`.

| File | Proves |
| --- | --- |
| `10_ledger.sql` | `wallet_post` is idempotent per reference; a reference owned by another account raises instead of swallowing a credit; overdrafts, bad types/statuses and missing wallets are refused; `PENDING` rows move nothing; the ledger rejects UPDATE and DELETE; frozen wallets refuse outbound money but still release held funds |
| `20_withdrawals.sql` | Reserve moves available → locked; minimums, maximums, the daily limit, pending-request limits and suspended accounts are enforced; **a payout cannot settle before an administrator approves it**; a second payout and a second release are no-ops; one provider transaction cannot settle two withdrawals; rejection and failure both restore the hold; the fee comes out of the hold, never the available balance |
| `30_deposits.sql` | A deposit is credited exactly once, for its own amount; replayed callbacks report `duplicate` and credit nothing; a failed deposit never credits and can never be credited later; late callbacks cannot downgrade a settled deposit |
| `40_videos.sql` | The reward comes from the database, never the caller; watch time is enforced server-side; a session rewards once; the campaign budget is a hard ceiling; paused campaigns, suspended accounts, daily limits and the velocity guard all block rewards |
| `50_referrals.sql` | Only the configured qualifying event (or a confirmed email) qualifies a referral; commission is 5% of an eligible deposit and is paid exactly once; unqualified referrals earn nothing; self-referral and a disabled level 2 are no-ops |
| `60_security.sql` | RLS is on for every table; there is no client INSERT/UPDATE/DELETE policy on a financial table; `anon`/`authenticated` cannot execute the money functions; a signed-in user sees only their own wallet and cannot forge a ledger row through any path |
| `99_conservation.sql` | **Every wallet balance equals the sum of its ledger entries.** Every settled withdrawal nets to zero; no hold is left stranded; every rewarded session, completed deposit and credited commission has exactly one matching ledger row of the same amount; no settled row has a zero effect; no campaign is overspent |

Three things worth knowing:

- The runner installs a minimal Supabase `auth` shim (schema, `auth.users`, `auth.uid()`, the three
  roles) when it finds a bare Postgres, so the suite runs in CI on a stock `postgres:17` container
  with **no Supabase secrets**. On a real Supabase project the shim is a no-op.
- `test:money:local` boots Postgres in-process from WebAssembly (PGlite) and serves it over the
  wire protocol, so it needs nothing installed and no secrets — the fastest way to check a change.
  It skips the concurrent case below, and translates the one `pgcrypto` statement PGlite does not
  bundle (`gen_random_uuid()` is core since Postgres 13, so nothing else is affected).
- The concurrent case — two sessions completing against a campaign budget that covers only one —
  needs two real committed transactions, so it runs on the scratch database with two connections
  and is skipped in `--mode=transaction` and `--mode=local`.

`.github/workflows/money-tests.yml` runs the suite on every push and pull request.

---

## Environment variables

See [`.env.example`](./.env.example) for the full annotated list. The essentials:

| Variable | Notes |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser-safe |
| `SUPABASE_SECRET_KEY` | **Server only.** Bypasses RLS. Legacy alias `SUPABASE_SERVICE_ROLE_KEY` is also accepted (the new name wins) |
| `SUPABASE_JWKS_URL` | Optional; only server-side JWT verification needs it. Must belong to the same project as `NEXT_PUBLIC_SUPABASE_URL` |
| `DATABASE_URL` | Migrations only — the running app never reads it. Session pooler on port 5432 |
| `APP_URL` / `NEXT_PUBLIC_APP_URL` | Public base URL |
| `AUTH_SECRET` | ≥32 chars; keys the identifier hashes |
| `CRON_SECRET` | Protects `/api/cron/reconcile` |
| `PAYMENTS_PROVIDER` | `payhero`, `mpesa` or `sasapay`. Unset: PayHero if its credentials are present, else `mpesa` |
| `PAYHERO_API_USERNAME` / `PAYHERO_API_PASSWORD` | **Server only.** PayHero API keys, sent as HTTP Basic |
| `PAYHERO_CHANNEL_ID` | The PayHero payment channel that receives the money |
| `PAYHERO_CALLBACK_URL` | Webhook PayHero posts results to; register it in the PayHero dashboard |
| `PAYHERO_CALLBACK_SECRET` / `PAYHERO_CALLBACK_IPS` | Callback hardening — set one in production |
| `PAYHERO_API_URL` | Optional; must be a `payhero.co.ke` host or it is refused |
| `MPESA_*` | Daraja credentials: consumer key/secret, shortcode, passkey, callback URL, and the separate `MPESA_B2C_*` payout set |
| `MPESA_CALLBACK_SECRET` / `MPESA_CALLBACK_IPS` | Callback hardening — preflight fails without one of them in production |
| `SASAPAY_*` | Merchant credentials, API base URL, callback URL (retained) |
| `SASAPAY_CALLBACK_SECRET` / `SASAPAY_CALLBACK_IPS` | Callback hardening |

**Production fails safely:** if the active provider's credentials are missing, payment functions
throw and the route says so. There is no fallback to simulated success, anywhere. `GET /api/health`
reports which credentials are missing by NAME (never by value), and `npm run preflight --production`
fails on an unconfigured provider.

### When the payment provider is not configured

Approving a withdrawal is a real decision and is recorded as one, but it cannot send money that the
platform has no account to send. So the approval lands, the funds stay **locked**, and the status
settles at `APPROVED` — never `PROCESSING`, never `COMPLETED`, and no payout record is created. The
admin screen shows why, and the API reports `paymentInitiated: false` so the UI cannot announce a
payout that did not happen.

The payment simulator does **not** unlock payouts. It still drives collections, where a simulated
deposit is visible and tagged `SIMULATED`; a simulated *disbursement* would write a completed payout
that never occurred, and once that is in the ledger it is indistinguishable from a real one. The
reconciliation sweep refuses to run without a provider for the same reason — an empty summary would
read as "everything checked out".

### Local development without live credentials

Set `SASAPAY_SIMULATOR=1`. This substitutes only the *provider's HTTP responses* — records, ledger
entries, idempotency, callbacks and reconciliation still run for real, and simulated activity is
tagged `SIMULATED`. It is ignored under `NODE_ENV=production`.

Outcome control is encoded in the payment reference: `…-FAIL`, `…-CANCEL`, `…-PENDING`, anything
else succeeds.

---

## Recurring operations

`GET /api/cron/reconcile` (daily in `vercel.json` — the Vercel account is Hobby, which forbids
sub-daily crons; see *Deploying to Vercel* for the 10-minute alternative) re-verifies unresolved deposits
and in-flight payouts, marks settled records, and raises `STALE_PENDING` alerts for anything
unanswered after an hour. Requires `Authorization: Bearer $CRON_SECRET`.

---

## Notes on extending this

- **New country/currency:** insert a row in `currencies` and set `enabled = true`. Phone validation
  and dialling codes live in `src/lib/countries.ts`.
- **Separate worker/Render backend:** the payment and accounting boundary is already server-side and
  provider-agnostic. `src/lib/payments/sasapay/*` and `src/server/services/*` can move to a Node
  worker without touching the schema or the ledger.
- **KYC:** states and the `withdrawals.require_verified_kyc` rule exist and are enforced; the
  provider integration itself is intentionally left for you to choose.

## Before launch

1. Fill in **Admin → Settings → legal** with your real operator details.
2. Have a lawyer review `src/content/legal.ts` (the policy pages are working drafts).
3. Supply the six M-Pesa credentials (`MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`,
   `MPESA_SHORTCODE`, `MPESA_PASSKEY`, `MPESA_B2C_INITIATOR_NAME`,
   `MPESA_B2C_SECURITY_CREDENTIAL`) and register the three callback URLs with Safaricom.
4. Set `MPESA_CALLBACK_SECRET` (or `MPESA_CALLBACK_IPS`) — Safaricom does not sign callbacks.
5. Point your Supabase email templates at `/auth/confirm`.
