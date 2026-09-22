/*
  0019 — pay for a package directly by M-Pesa.

  Until now a deposit had no idea what it was for. `deposits` carried an amount,
  a phone and a provider reference, and nothing recorded intent — so "buy this
  package with M-Pesa" had nowhere to say WHICH package the money was sent for.
  A user who paid KES 2,500 from the package page simply got KES 2,500 in their
  wallet, and had to go and spend it themselves.

  This adds the missing link. When `package_id` is set, the deposit is payment
  for that package: the amount is the package's current price (forced server-side
  from the package row, never from the request), and settlement activates the
  package in the same request that credits the wallet.

  Why columns rather than a joining table: a deposit pays for at most one
  package, and the link must be readable on the deposit row itself by every
  existing reader — the customer's history, the admin table, the reconciliation
  sweep — without a join. `on delete set null` because removing a package must
  never remove the evidence that money was taken.

  The two activation columns are what make "exactly one package per payment"
  provable after the fact: `package_activated_at` is set only when the purchase
  actually succeeded, and `package_purchase_id` names the `user_packages` row it
  produced. A deposit that is COMPLETED, carries a `package_id`, and has a NULL
  `package_activated_at` is therefore a payment that has been credited but whose
  package has not been activated yet — which is exactly the state a crash
  between the two leaves, and exactly the state the settlement path repairs when
  it is asked about the deposit again.
*/

alter table public.deposits
  add column if not exists package_id uuid
    references public.packages(id) on delete set null;

comment on column public.deposits.package_id is
  'When set, this deposit is payment for that package: the amount is the '
  'package price at the time of the request and settlement activates it.';

alter table public.deposits
  add column if not exists package_activated_at timestamptz;

comment on column public.deposits.package_activated_at is
  'When the package this deposit paid for was actually activated. NULL on a '
  'package deposit means the credit succeeded but the activation has not run.';

alter table public.deposits
  add column if not exists package_purchase_id uuid
    references public.user_packages(id) on delete set null;

comment on column public.deposits.package_purchase_id is
  'The purchase this deposit produced. Named so a payment can be traced to the '
  'package it bought without matching on amount and timestamp.';

/*
  Partial: the overwhelming majority of deposits are wallet top-ups, and they all
  have package_id NULL. A partial index keeps the package-payment lookups cheap
  without carrying an entry per ordinary deposit.
*/
create index if not exists deposits_package_id_idx
  on public.deposits (package_id)
  where package_id is not null;

/*
  The same migration also adds the longer-term tiers.

  These are DRAFT, deliberately. `listPackageCatalogue` shows only ACTIVE tiers,
  and `package_videos` has a UNIQUE index on `video_id` — one video belongs to
  exactly one package — so a new tier starts with an EMPTY catalogue and would
  sell a KES 5,000 product that can pay nothing until videos are allocated to it.
  As DRAFT rows they exist, are priced, and are one review away from sale, but no
  one can buy one in this state.

  The caps follow the rule the ten existing tiers already follow, measured from
  them rather than invented: lifetime = price x 1.19, daily = lifetime / days,
  max_withdrawal = price x 1.25. At these price points that lands every tier on
  the same daily cap (KES 99.17) with a different total, read as "same earning
  rate per day, longer commitment, more in total".

  To put one on sale: allocate videos to it and flip it to ACTIVE in
  /admin/packages. `npm run allocate:videos` splits the whole catalogue across
  whatever is ACTIVE, so activating a tier and re-running it re-divides the 304
  videos across all of them — the existing tiers' catalogues get smaller.
*/

insert into public.packages (
  name, description, price, currency,
  daily_earning_cap, lifetime_earning_cap, duration_days, max_withdrawal,
  status, sort_order
)
select
  'Package 2500 (30 days)',
  'Longer-term tier. Same daily earning rate as the 14-day packages, for 30 days.',
  2500, 'KES', 99.17, 2975, 30, 3125, 'DRAFT', 210
where not exists (select 1 from public.packages where name = 'Package 2500 (30 days)');

insert into public.packages (
  name, description, price, currency,
  daily_earning_cap, lifetime_earning_cap, duration_days, max_withdrawal,
  status, sort_order
)
select
  'Package 5000 (60 days)',
  'Longer-term tier. Same daily earning rate as the 14-day packages, for 60 days.',
  5000, 'KES', 99.17, 5950, 60, 6250, 'DRAFT', 220
where not exists (select 1 from public.packages where name = 'Package 5000 (60 days)');

insert into public.packages (
  name, description, price, currency,
  daily_earning_cap, lifetime_earning_cap, duration_days, max_withdrawal,
  status, sort_order
)
select
  'Package 7500 (90 days)',
  'Longer-term tier. Same daily earning rate as the 14-day packages, for 90 days.',
  7500, 'KES', 99.17, 8925, 90, 9375, 'DRAFT', 230
where not exists (select 1 from public.packages where name = 'Package 7500 (90 days)');
