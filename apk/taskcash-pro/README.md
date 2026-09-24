# TaskCash Pro — UI prototype

A standalone, responsive front-end recreation of the TaskCash Pro rewards dashboard.

> **Demo only.** There is no backend, no authentication service, no payment provider
> and no database. Balances, packages, tasks and ledger entries are mock data held
> in `localStorage`. No real money can move, and nothing in this folder is connected
> to the production TaskCash application.

## Running it

```bash
cd apk/taskcash-pro
npm install
npm run dev      # http://localhost:4310
```

Other scripts: `npm run build`, `npm start`, `npm run typecheck`.

## Routes

| Route | Screen |
| --- | --- |
| `/` | Redirects to `/login` |
| `/login` | Mock sign-in (any valid-looking email + 4-char password) |
| `/dashboard` | Balance, statistics, quick actions, package summary |
| `/watch` | Timed watch tasks with claim gating and a daily quota |
| `/packages` | Tier summary cards and the performance table |
| `/packages/[id]` | Package detail: duration, payout, spec rows, activation |
| `/wallet` | Balance breakdown, flow totals, recent activity |
| `/deposit` | Mock top-up with a confirmation step |
| `/withdraw` | Instant cashout form and withdrawal history |
| `/transactions` | Full ledger with kind filters |
| `/referrals` | Referral code, copy/share, invitee list |
| `/profile` | Profile editing, preferences, reset and logout |

## Layout

- `app/` — one folder per route.
- `components/` — reusable UI: `AppShell`, `Sidebar`, `MobileNav`, `Header`,
  `BalanceCard`, `StatCard`, `PackageCard`, `PackageTable`, `TaskCard`,
  `WalletCard`, `TransactionItem`, `PrimaryButton`, `StatusBadge`, `Modal`, `Toast`.
- `lib/` — `types.ts` (domain interfaces), `mock-data.ts` (the seed dataset),
  `store.tsx` (state + persistence), `fees.ts` (withdrawal pricing), `format.ts`
  (formatting), `nav.ts`, `compliance-documents.ts`.
- `public/documents/` — the statutory scans behind the KRA button.

All demo content is defined in `lib/mock-data.ts`. Editing the tier table there
updates the cards, the table and the detail pages together — nothing is
hard-coded into a component.

## Behaviour worth knowing

The gating is modelled honestly even though the money is not:

- A task reward can only be claimed once, and only after its watch timer has run.
- A daily quota is enforced, set by the highest active tier.
- Tasks from a tier you have not activated stay locked.
- A package cannot be activated unless the wallet balance covers it.
- A withdrawal cannot exceed the available balance; pending funds move to `locked`
  rather than disappearing.
- Package expiry is computed from stored timestamps, not the browser's opinion of
  "now".

## Withdrawal fee

Every withdrawal is charged a **10% fee**, defined once in `lib/fees.ts`
(`WITHDRAWAL_FEE_RATE`). The fee is taken out of the amount requested:

```
request 1,000  →  fee 100  →  you receive 900
```

The full 1,000 leaves the available balance; while the request is pending that
1,000 sits in `locked`, and the withdrawal history records both the gross and the
net. Four places render this figure — the form preview, the confirmation, the
ledger row and the fee totals on Wallet and Withdraw — and all four read
`quoteWithdrawal()`, so they cannot disagree. Changing the rate is a one-line
change in `lib/fees.ts`.

## Company documents

The **KRA** button on the dashboard footer opens the registered company scans
served from `public/documents/`. These are the same files the production
application serves. Metadata for them lives in `lib/compliance-documents.ts`.

Note for whoever reviews them next: both are Registrar of Companies filings, not
Kenya Revenue Authority documents. "KRA" is the requested button label; the dialog
names each document by its actual issuer.

## State

Everything lives under the `taskcash-pro:state:v1` and `taskcash-pro:session:v1`
keys in `localStorage`. **Profile → Reset demo data** clears both and restores a
fresh account. The seeded account starts with a small balance and one active tier
so every flow can be exercised immediately.

## Note for maintainers

This folder is excluded from the parent repository's build:

- `tsconfig.json` (parent) excludes `apk`, so `next build` never type-checks these files.
- `.vercelignore` (parent) excludes `apk`, so it is never uploaded in a deployment.
- `next.config.mjs` here pins `outputFileTracingRoot` to this directory so Next does
  not trace the parent repository during a build.

If this prototype is ever removed, those three lines should go with it.
