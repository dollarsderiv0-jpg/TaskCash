-- ============================================================================
-- TaskCash Pro — 0014 Packages (paid earning tiers with a daily cap)
--
-- WHAT A PACKAGE IS
--
-- An operator-defined tier a user BUYS OUT OF THEIR OWN WALLET. It bundles a
-- set of videos and grants the right to earn from them, up to a DAILY earning
-- cap. When the cap is reached, earning inside that package stops until the next
-- calendar day and the UI shows a countdown to the reset.
--
--   · price            — what the user pays, debited through the ledger
--   · daily_earning_cap — the most that package can pay that user in one day
--   · package_videos    — which videos the tier unlocks
--
-- The operator's own documented tier list (800 / 2,500 / 5,000 / 7,000 /
-- 12,000 / 15,000 / 25,000 / 40,000 KES) is seeded at the bottom of this file as
-- DRAFT with NO earning cap set. See "WHY THE SEEDED TIERS ARE DRAFT" there.
--
--
-- FOUR DESIGN RULES, AND WHY EACH ONE MATTERS
--
-- 1. THE CAP IS ENFORCED IN THE DATABASE, TWICE.
--    `video_start` refuses to start a session once the cap is reached (so the
--    user is shown a countdown instead of being allowed to watch and then
--    refused), and `video_complete_session` re-checks it inside the same
--    transaction that posts the reward, under an advisory lock. A reward can
--    therefore never exceed the cap even if two sessions are collected at the
--    same instant.
--
-- 2. THE CAP IS A SNAPSHOT, TAKEN AT PURCHASE.
--    `user_packages.daily_earning_cap` copies the package's cap at the moment of
--    sale. If an admin later lowers the package's cap, a user who already paid
--    keeps the terms they bought. An admin can still move someone onto the new
--    terms deliberately (update their row), but they cannot do it by accident.
--
-- 3. A VIDEO BELONGS TO AT MOST ONE PACKAGE.
--    Enforced by a unique index on `package_videos.video_id`. If a video could
--    sit in two packages, "which cap applies" would have no single answer, and
--    the cap would be trivially doubled by finding a video that appears twice.
--
-- 4. VIDEOS IN NO PACKAGE STAY FREE.
--    The existing house catalogue is not retro-fitted into a tier. A video with
--    no `package_videos` row behaves exactly as it does today: no purchase
--    needed and no package cap. That keeps the current watch-and-earn flow
--    working unchanged and lets tiers be added incrementally.
--
--
-- WHAT THIS DOES NOT DO
--
-- It does not invent an earning figure. A package with `daily_earning_cap = 0`
-- means "no cap configured", and is therefore NOT PURCHASABLE (see
-- `package_purchase`) and NOT STARTABLE. The default is fail-closed: an
-- unfinished package can never be sold by accident.
--
-- It also does not promise a return, and the UI must not either. A package is
-- paid access to a bounded daily earning allowance; the platform pays it out of
-- its own revenue. Whether that revenue exists is an operator question, not a
-- database one — see the note at the end of this file.
--
-- APPLY VIA supabase/apply-all.sql (regenerate with `npm run db:bundle`).
-- ============================================================================


-- ============================================================================
-- 1. tables
-- ============================================================================

create table if not exists public.packages (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  description        text,
  -- What the user pays. Read from here, never from a client, at purchase time.
  price              numeric(20,4) not null check (price > 0),
  currency           text not null references public.currencies(code),
  /*
    The most this package can pay one user in a single calendar day.
    0 means "not configured" and makes the package unpurchasable — the safe
    default, because a package that cannot be bought cannot promise an income
    nobody has agreed to fund.
  */
  daily_earning_cap  numeric(20,4) not null default 0 check (daily_earning_cap >= 0),
  /*
    The most this package can EVER pay, across the whole life of one purchase.

    NULL means "no ceiling", and that is deliberately not the same as 0. A daily
    cap of 0 means "not configured" and makes the tier unpurchasable; a lifetime
    cap of 0 would mean "may never pay anything", which is a tier that takes the
    money and pays nothing. The check below makes that value impossible rather
    than merely discouraged.

    It is enforced per PURCHASE, not per user: a user who buys the same tier
    again after its term ends gets the ceiling again, because the alternative is
    selling them a package they have already exhausted and can never earn from.
  */
  lifetime_earning_cap numeric(20,4)
                       check (lifetime_earning_cap is null or lifetime_earning_cap > 0),
  /*
    How long a purchase stays earnable, counted from the moment it is bought.
    NULL means the purchase never lapses. Positive only, so 0 cannot be read as
    "expires instantly" by half the code and "never" by the other half.

    Set at purchase time onto `user_packages.expires_at`, which every cap check
    already honours — that is how the term is enforced without a second rule.
  */
  duration_days      int check (duration_days is null or duration_days > 0),
  status             text not null default 'DRAFT' check (status in (
                       'DRAFT','ACTIVE','PAUSED','ARCHIVED')),
  sort_order         int not null default 100 check (sort_order >= 0),
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint packages_name_len check (char_length(btrim(name)) between 2 and 120)
);

create index if not exists packages_catalogue_idx
  on public.packages (status, sort_order, price);

drop trigger if exists trg_packages_updated on public.packages;
create trigger trg_packages_updated
  before update on public.packages
  for each row execute function public.touch_updated_at();


/* -------------------------------------------------------------------------- */
/* which videos a tier unlocks                                                */
/* -------------------------------------------------------------------------- */

create table if not exists public.package_videos (
  package_id uuid not null references public.packages(id) on delete cascade,
  video_id   uuid not null references public.videos(id)   on delete cascade,
  sort_order int not null default 100 check (sort_order >= 0),
  added_at   timestamptz not null default now(),
  primary key (package_id, video_id)
);

/*
  ONE package per video. This is the constraint that makes the cap meaningful:
  with a video in two tiers, a user holding both could earn against whichever cap
  was more convenient, and the pair of caps would silently become additive.
*/
create unique index if not exists package_videos_one_package_idx
  on public.package_videos (video_id);

create index if not exists package_videos_package_idx
  on public.package_videos (package_id, sort_order);


/* -------------------------------------------------------------------------- */
/* what a user has bought                                                     */
/* -------------------------------------------------------------------------- */

create table if not exists public.user_packages (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.profiles(id) on delete cascade,
  package_id              uuid not null references public.packages(id) on delete restrict,
  -- Snapshot of the terms at the moment of sale (see design rule 2).
  price_paid              numeric(20,4) not null check (price_paid >= 0),
  currency                text not null references public.currencies(code),
  daily_earning_cap       numeric(20,4) not null check (daily_earning_cap >= 0),
  -- Snapshot of the lifetime ceiling at the moment of sale; NULL = none.
  lifetime_earning_cap    numeric(20,4)
                          check (lifetime_earning_cap is null or lifetime_earning_cap > 0),
  purchase_transaction_id uuid unique references public.wallet_transactions(id) on delete set null,
  purchase_reference      text not null unique,
  status                  text not null default 'ACTIVE' check (status in (
                            'ACTIVE','EXPIRED','REVOKED')),
  purchased_at            timestamptz not null default now(),
  /*
    Null means the purchase does not lapse. Now SET at purchase time from
    `packages.duration_days` — the time-limited tier this column was added for
    exists (0014 seeds ten of them), and `package_daily_usage` has always
    ignored a lapsed purchase, so the term needs no separate enforcement.
  */
  expires_at              timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint user_packages_expiry_after_purchase
    check (expires_at is null or expires_at > purchased_at)
);

/*
  At most one ACTIVE purchase per user per package. Buying the same tier twice
  while it is live is refused outright (`PACKAGE_ALREADY_ACTIVE`) rather than
  silently debiting a second time; buying again after expiry IS allowed, because
  the second purchase is a new row.
*/
create unique index if not exists user_packages_one_active_idx
  on public.user_packages (user_id, package_id)
  where status = 'ACTIVE';

create index if not exists user_packages_user_idx
  on public.user_packages (user_id, status, purchased_at desc);

drop trigger if exists trg_user_packages_updated on public.user_packages;
create trigger trg_user_packages_updated
  before update on public.user_packages
  for each row execute function public.touch_updated_at();


/* -------------------------------------------------------------------------- */
/* which package a watch session earned under                                 */
/* -------------------------------------------------------------------------- */

alter table public.video_watch_sessions
  add column if not exists package_id uuid references public.packages(id) on delete set null;

/*
  The cap is computed from SESSIONS rather than from a running counter. A counter
  is a second source of truth that can drift from the ledger; this cannot,
  because it reads the ledger rows themselves.

  Indexed on the exact shape the calculation uses.
*/
create index if not exists video_watch_sessions_package_reward_idx
  on public.video_watch_sessions (user_id, package_id, rewarded_at desc)
  where package_id is not null;


-- ============================================================================
-- 2. the day boundary
-- ============================================================================

/*
  Midnight in the operator's own timezone, as an instant.

  A "calendar day" that resets at UTC midnight would reset at 03:00 for the
  operator's users, which is both surprising and exploitable (a user near the
  boundary gets two allowances inside one waking day). This function is the ONE
  definition of the day; the cap check and the countdown both read it, so the
  number the user is shown is the number that is enforced.
*/
create or replace function public.day_start_eat(p_at timestamptz default now())
returns timestamptz
language sql
immutable
as $$
  select date_trunc('day', p_at at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi';
$$;

comment on function public.day_start_eat(timestamptz) is
  'Start of the calendar day containing p_at, in Africa/Nairobi (UTC+3). The single definition of the daily earning window.';

revoke all on function public.day_start_eat(timestamptz) from public;


-- ============================================================================
-- 3. reading a package's daily usage
-- ============================================================================

/*
  Dropped before it is re-created, and not out of tidiness: `create or replace`
  cannot change a function's OUT parameters, so adding the lifetime columns below
  to `returns table` would fail with "cannot change return type of existing
  function" on any database that already has the 0014 version.
*/
drop function if exists public.package_daily_usage(uuid, uuid);

create or replace function public.package_daily_usage(
  p_user_id    uuid,
  p_package_id uuid
)
returns table (
  earned_today         numeric,
  daily_cap            numeric,
  remaining            numeric,
  resets_at            timestamptz,
  has_active_purchase  boolean,
  earned_total         numeric,
  lifetime_cap         numeric,
  lifetime_remaining   numeric,
  purchase_expires_at  timestamptz,
  purchase_expired     boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start          timestamptz;
  v_end            timestamptz;
  v_package        public.packages;
  v_purchase       public.user_packages;
  v_earned         numeric;
  v_earned_total   numeric;
  v_lapsed_expires timestamptz;
  v_lifetime_cap   numeric;
begin
  v_start := public.day_start_eat(now());
  v_end   := v_start + interval '1 day';

  select * into v_package from public.packages where id = p_package_id;

  select * into v_purchase
    from public.user_packages up
   where up.user_id = p_user_id
     and up.package_id = p_package_id
     and up.status = 'ACTIVE'
     and (up.expires_at is null or up.expires_at > now())
   limit 1;

  /*
    Earned today, derived from the LEDGER. `s.package_id` and `wt.` are fully
    qualified on purpose: an unqualified column name that collides with an OUT
    parameter is exactly the bug 0011 had to fix in video_progress, and it fails
    at execution time rather than at parse time.
  */
  select coalesce(sum(wt.amount), 0) into v_earned
    from public.video_watch_sessions s
    join public.wallet_transactions wt on wt.id = s.reward_transaction_id
   where s.user_id = p_user_id
     and s.package_id = p_package_id
     and wt.status = 'COMPLETED'
     and s.rewarded_at >= v_start
     and s.rewarded_at <  v_end;

  /*
    Earned under THIS purchase, for the lifetime ceiling.

    A watch session records which package it belongs to but not which purchase,
    so the purchase's own window is the anchor: from `purchased_at` until it
    lapses. That window is unambiguous because a user cannot hold two active
    purchases of one package — the purchase function refuses the second.

    Zero when there is no purchase, which is what a prospective buyer sees: the
    package's own ceiling, not somebody else's usage.
  */
  select coalesce(sum(wt.amount), 0) into v_earned_total
    from public.video_watch_sessions s
    join public.wallet_transactions wt on wt.id = s.reward_transaction_id
   where s.user_id = p_user_id
     and s.package_id = p_package_id
     and wt.status = 'COMPLETED'
     and v_purchase.id is not null
     and s.rewarded_at >= v_purchase.purchased_at
     and (v_purchase.expires_at is null or s.rewarded_at < v_purchase.expires_at);

  /*
    A lapsed purchase is invisible to the lookup above — it is filtered out by
    `expires_at > now()` — which would report "you need a package" to someone who
    bought one and simply ran out of days. Found separately so the caller can say
    which of the two happened.
  */
  select up.expires_at into v_lapsed_expires
    from public.user_packages up
   where up.user_id = p_user_id
     and up.package_id = p_package_id
     and up.status = 'ACTIVE'
     and up.expires_at is not null
     and up.expires_at <= now()
   order by up.expires_at desc
   limit 1;

  earned_today        := v_earned;
  /*
    The PURCHASE's snapshot wins when there is one. Falling back to the package's
    current cap is what lets a prospective buyer be shown the terms on offer.
  */
  daily_cap           := coalesce(v_purchase.daily_earning_cap, v_package.daily_earning_cap, 0);
  remaining           := greatest(0, coalesce(v_purchase.daily_earning_cap, v_package.daily_earning_cap, 0) - v_earned);
  resets_at           := v_end;
  has_active_purchase := v_purchase.id is not null;

  v_lifetime_cap      := coalesce(v_purchase.lifetime_earning_cap, v_package.lifetime_earning_cap);
  earned_total        := v_earned_total;
  lifetime_cap        := v_lifetime_cap;
  -- NULL, not 0: "no ceiling" and "nothing left" are opposite facts.
  lifetime_remaining  := case
                           when v_lifetime_cap is null then null
                           else greatest(0, v_lifetime_cap - v_earned_total)
                         end;
  purchase_expires_at := v_purchase.expires_at;
  purchase_expired    := v_purchase.id is null and v_lapsed_expires is not null;
  return next;
end;
$$;

-- User-scoped by parameter, so it must NOT be callable by a user session: it
-- would otherwise read another account's earnings by passing their id.
revoke all on function public.package_daily_usage(uuid, uuid) from public, anon, authenticated;
grant execute on function public.package_daily_usage(uuid, uuid) to service_role;


-- ============================================================================
-- 4. buying a package
-- ============================================================================

create or replace function public.package_purchase(
  p_user_id    uuid,
  p_package_id uuid
)
returns table (
  purchase_id        uuid,
  package_id         uuid,
  package_name       text,
  price_paid         numeric,
  currency           text,
  daily_earning_cap  numeric,
  transaction_id     uuid,
  reference          text,
  available_balance  numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile     public.profiles;
  v_package     public.packages;
  v_wallet      public.wallets;
  v_purchase_id uuid;
  v_ref         text;
  v_tx          public.wallet_transactions;
begin
  -- One purchase at a time per (user, package): two concurrent attempts cannot
  -- both pass the "already active" check and both debit.
  perform pg_advisory_xact_lock(hashtext('package:' || p_user_id::text || ':' || p_package_id::text));

  select * into v_profile from public.profiles where id = p_user_id;
  if not found then
    raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_profile.status <> 'ACTIVE' then
    raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if v_profile.risk_status in ('RESTRICTED','SUSPENDED') then
    raise exception 'ACCOUNT_RESTRICTED' using errcode = 'P0001';
  end if;

  -- Locked for the duration of the transaction, so the price and the cap the
  -- user is charged cannot be edited out from under this purchase.
  select * into v_package from public.packages where id = p_package_id for update;
  if not found then
    raise exception 'PACKAGE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_package.status <> 'ACTIVE' then
    raise exception 'PACKAGE_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
  if v_package.daily_earning_cap <= 0 then
    -- Fail closed. Selling a tier with no configured earning allowance would
    -- take the user's money and give them a package that can never pay.
    raise exception 'PACKAGE_NOT_AVAILABLE' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.user_packages up
     where up.user_id = p_user_id
       and up.package_id = p_package_id
       and up.status = 'ACTIVE'
       and (up.expires_at is null or up.expires_at > now())
  ) then
    raise exception 'PACKAGE_ALREADY_ACTIVE' using errcode = 'P0001';
  end if;

  select * into v_wallet from public.wallets where user_id = p_user_id;
  if not found then
    raise exception 'WALLET_NOT_FOUND' using errcode = 'P0002';
  end if;
  -- The ledger posts in the wallet's currency, so a package priced in another
  -- one would debit the wrong number of shillings.
  if v_wallet.currency <> v_package.currency then
    raise exception 'PACKAGE_CURRENCY_MISMATCH' using errcode = 'P0001';
  end if;

  /*
    The id is generated here rather than by the insert, so the ledger reference
    can be derived from it before either row exists. One purchase has exactly one
    ledger reference ('PKG-<purchase id>'), which makes a retry of the same
    purchase idempotent at the ledger rather than a second debit.

    Both rows are written in this transaction. If the debit raises — most
    commonly INSUFFICIENT_AVAILABLE_BALANCE — everything rolls back and no
    purchase row survives a payment that did not happen.
  */
  v_purchase_id := gen_random_uuid();
  v_ref := 'PKG-' || v_purchase_id::text;

  insert into public.user_packages (
    id, user_id, package_id, price_paid, currency, daily_earning_cap,
    lifetime_earning_cap, purchase_reference, status, expires_at
  ) values (
    v_purchase_id, p_user_id, p_package_id, v_package.price, v_package.currency,
    v_package.daily_earning_cap,
    /*
      Both ceilings are snapshotted, for the same reason as the daily cap: the
      operator can re-price a tier tomorrow, and a purchase has to keep the terms
      it was sold under.
    */
    v_package.lifetime_earning_cap,
    v_ref, 'ACTIVE',
    /*
      The term, stamped once. NULL when the tier does not lapse. Every cap check
      reads `expires_at > now()`, so this single value is what ends the earning
      window — there is no second expiry rule to keep in step.
    */
    case
      when v_package.duration_days is null then null
      else now() + make_interval(days => v_package.duration_days)
    end
  );

  v_tx := public.wallet_post(
    p_user_id     => p_user_id,
    p_type        => 'PACKAGE_PURCHASE',
    p_amount      => v_package.price,
    p_status      => 'COMPLETED',
    p_reference   => v_ref,
    p_description => 'Package purchase: ' || v_package.name,
    p_metadata    => jsonb_build_object(
                       'package_id',   v_package.id,
                       'package_name', v_package.name,
                       'purchase_id',  v_purchase_id,
                       'daily_earning_cap', v_package.daily_earning_cap,
                       'lifetime_earning_cap', v_package.lifetime_earning_cap,
                       'duration_days', v_package.duration_days
                     ),
    p_source      => 'PACKAGE'
  );

  update public.user_packages
     set purchase_transaction_id = v_tx.id
   where id = v_purchase_id;

  /*
    The notification states the ceilings and the term, and nothing else. It does
    not say what the package will pay: the daily figure is the most its videos
    can pay, and whether they pay it depends on the campaigns behind them.
  */
  perform public.notify_user(
    p_user_id, 'PACKAGE_ACTIVATED', 'Package activated',
    'Your ' || v_package.name || ' package is active. From its videos you can earn up to ' ||
      v_package.currency || ' ' || to_char(v_package.daily_earning_cap, 'FM999,999,990.00') ||
      ' per day' ||
      case
        when v_package.lifetime_earning_cap is not null then
          ', up to ' || v_package.currency || ' ' ||
          to_char(v_package.lifetime_earning_cap, 'FM999,999,990.00') || ' in total'
        else ''
      end ||
      case
        when v_package.duration_days is not null then
          ', for ' || v_package.duration_days || ' day' ||
          case when v_package.duration_days = 1 then '' else 's' end
        else ''
      end || '.',
    'SUCCESS', '/dashboard/packages'
  );

  -- Actor is the user, not an admin: this is a self-service purchase. Recording
  -- it under admin_id would misreport it as an administrative action.
  perform public.write_audit(
    null, p_user_id, 'PACKAGE_PURCHASED', 'package', v_purchase_id::text,
    'Purchased package "' || v_package.name || '" for ' || v_package.currency || ' ' ||
      to_char(v_package.price, 'FM999,999,990.00'),
    jsonb_build_object(
      'package_id', v_package.id, 'price', v_package.price,
      'daily_earning_cap', v_package.daily_earning_cap,
      'lifetime_earning_cap', v_package.lifetime_earning_cap,
      'duration_days', v_package.duration_days, 'reference', v_ref
    ),
    null, null
  );

  select w.available_balance into available_balance
    from public.wallets w where w.user_id = p_user_id;

  purchase_id       := v_purchase_id;
  package_id        := v_package.id;
  package_name      := v_package.name;
  price_paid        := v_package.price;
  currency          := v_package.currency;
  daily_earning_cap := v_package.daily_earning_cap;
  transaction_id    := v_tx.id;
  reference         := v_ref;
  return next;
end;
$$;

revoke all on function public.package_purchase(uuid, uuid) from public, anon, authenticated;
grant execute on function public.package_purchase(uuid, uuid) to service_role;


-- ============================================================================
-- 5. the ledger needs a PACKAGE_PURCHASE type
-- ============================================================================

/*
  The type list is a CHECK constraint that was written inline and unnamed in
  0001. Rather than guess its generated name and risk leaving the OLD constraint
  in place (which would keep rejecting PACKAGE_PURCHASE while the new one sat
  harmlessly beside it), the definition is located by what it contains. It is
  then re-added under an explicit name so future migrations can drop it directly.
*/
do $$
declare
  v_name text;
begin
  select conname into v_name
    from pg_constraint
   where conrelid = 'public.wallet_transactions'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) like '%''VIDEO_REWARD''%'
   limit 1;

  if v_name is not null then
    execute format('alter table public.wallet_transactions drop constraint %I', v_name);
  end if;
end $$;

alter table public.wallet_transactions
  add constraint wallet_transactions_type_check check (type in (
    'DEPOSIT','VIDEO_REWARD','TASK_REWARD','REFERRAL_REWARD',
    'WITHDRAWAL_HOLD','WITHDRAWAL','WITHDRAWAL_FEE','WITHDRAWAL_RELEASE',
    'REFUND','REVERSAL','ADMIN_ADJUSTMENT','PACKAGE_PURCHASE'));


-- ============================================================================
-- 6. wallet_post — PACKAGE_PURCHASE branch
--
-- The body below is a copy of 0002's definition with exactly two changes, so a
-- reader can diff it against that file and see nothing else moved:
--
--   (a) `when 'PACKAGE_PURCHASE'` — available -> out, no bucket is locked. The
--       money leaves the platform's obligation to the user; unlike a withdrawal
--       hold there is nothing to reserve, because the package is not money the
--       user can withdraw later.
--   (b) PACKAGE_PURCHASE joins the list a FROZEN wallet refuses. A freeze exists
--       to stop money leaving an account, and a purchase is money leaving.
--
-- tests/sql/10_ledger.sql runs against whichever definition is live, so a
-- transcription slip here fails the suite rather than reaching production.
-- ============================================================================

create or replace function public.wallet_post(
  p_user_id            uuid,
  p_type               text,
  p_amount             numeric,
  p_status             text default 'COMPLETED',
  p_reference          text default null,
  p_external_reference text default null,
  p_description        text default null,
  p_metadata           jsonb default '{}'::jsonb,
  p_source             text default 'SYSTEM',
  p_created_by         uuid default null
)
returns public.wallet_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet       public.wallets;
  v_tx           public.wallet_transactions;
  v_avail_delta  numeric(20,4);
  v_locked_delta numeric(20,4);
  v_direction    text;
begin
  if p_amount is null then
    raise exception 'LEDGER_AMOUNT_INVALID' using errcode = '22023';
  end if;
  if p_reference is null or length(p_reference) < 4 then
    raise exception 'LEDGER_REFERENCE_REQUIRED' using errcode = '22023';
  end if;
  if p_status not in ('PENDING','PROCESSING','COMPLETED','FAILED','REJECTED','CANCELLED','REVERSED') then
    raise exception 'LEDGER_STATUS_INVALID' using errcode = '22023';
  end if;

  -- Serialize concurrent posts that share a reference so the
  -- "check then insert" below cannot race. Released at commit/rollback.
  perform pg_advisory_xact_lock(hashtext('wallet_post:' || p_reference));

  select * into v_tx from public.wallet_transactions where reference = p_reference;
  if found then
    -- Idempotent replay: return the original row, do not move money again.
    -- A reference that resolves to *another* account is not a replay, it is a
    -- collision; raising is safer than silently swallowing a real movement.
    if v_tx.user_id <> p_user_id then
      raise exception 'LEDGER_REFERENCE_CONFLICT' using errcode = 'P0001';
    end if;
    return v_tx;
  end if;

  -- Lock the wallet for the remainder of the transaction.
  select * into v_wallet from public.wallets where user_id = p_user_id for update;
  if not found then
    raise exception 'WALLET_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- A wallet that is not ACTIVE fails closed. FROZEN blocks outbound money,
  -- which is the point of a freeze, while still allowing funds back in so a
  -- frozen wallet never strands a user's locked balance. CLOSED blocks both.
  if v_wallet.status = 'CLOSED' then
    raise exception 'WALLET_CLOSED' using errcode = 'P0001';
  end if;
  if v_wallet.status = 'FROZEN' then
    if p_type in ('WITHDRAWAL_HOLD', 'WITHDRAWAL', 'WITHDRAWAL_FEE', 'PACKAGE_PURCHASE')
       or (p_type = 'ADMIN_ADJUSTMENT' and p_amount < 0) then
      raise exception 'WALLET_FROZEN' using errcode = 'P0001';
    end if;
  end if;

  case p_type
    when 'DEPOSIT', 'VIDEO_REWARD', 'TASK_REWARD', 'REFERRAL_REWARD', 'REFUND' then
      if p_amount <= 0 then
        raise exception 'LEDGER_AMOUNT_INVALID' using errcode = '22023';
      end if;
      v_avail_delta := p_amount; v_locked_delta := 0; v_direction := 'CREDIT';

    when 'ADMIN_ADJUSTMENT' then
      if p_amount = 0 then
        raise exception 'LEDGER_AMOUNT_INVALID' using errcode = '22023';
      end if;
      v_avail_delta := p_amount; v_locked_delta := 0;
      v_direction := case when p_amount > 0 then 'CREDIT' else 'DEBIT' end;

    when 'WITHDRAWAL_HOLD' then
      if p_amount <= 0 then
        raise exception 'LEDGER_AMOUNT_INVALID' using errcode = '22023';
      end if;
      v_avail_delta := -p_amount; v_locked_delta := p_amount; v_direction := 'DEBIT';

    when 'WITHDRAWAL' then
      if p_amount <= 0 then
        raise exception 'LEDGER_AMOUNT_INVALID' using errcode = '22023';
      end if;
      v_avail_delta := 0; v_locked_delta := -p_amount; v_direction := 'DEBIT';

    when 'WITHDRAWAL_FEE' then
      -- The fee is settled out of the held funds, never out of available
      -- balance: withdrawal_reserve() moved the *gross* amount into `locked`,
      -- so the fee is still sitting there. Taking it from `available` as well
      -- would charge the user twice and leave the fee stranded in `locked`
      -- forever. Together with the WITHDRAWAL entry (net), this empties the
      -- hold exactly.
      if p_amount <= 0 then
        raise exception 'LEDGER_AMOUNT_INVALID' using errcode = '22023';
      end if;
      v_avail_delta := 0; v_locked_delta := -p_amount; v_direction := 'DEBIT';

    when 'REVERSAL', 'WITHDRAWAL_RELEASE' then
      -- Returns held funds to the available bucket. WITHDRAWAL_RELEASE is the
      -- withdrawal-specific spelling of the same movement, kept as its own
      -- type so a reader can tell why a hold ended without parsing metadata.
      if p_amount <= 0 then
        raise exception 'LEDGER_AMOUNT_INVALID' using errcode = '22023';
      end if;
      v_avail_delta := p_amount; v_locked_delta := -p_amount; v_direction := 'CREDIT';

    -- NEW IN 0014: buying a package is money out of the available balance. No
    -- bucket is held, because a package is not a balance the user can withdraw.
    when 'PACKAGE_PURCHASE' then
      if p_amount <= 0 then
        raise exception 'LEDGER_AMOUNT_INVALID' using errcode = '22023';
      end if;
      v_avail_delta := -p_amount; v_locked_delta := 0; v_direction := 'DEBIT';

    else
      raise exception 'LEDGER_TYPE_INVALID' using errcode = '22023';
  end case;

  -- Only settled movements touch balances. PENDING rows are informational.
  if p_status not in ('COMPLETED','PROCESSING') then
    v_avail_delta := 0;
    v_locked_delta := 0;
  end if;

  if v_wallet.available_balance + v_avail_delta < 0 then
    raise exception 'INSUFFICIENT_AVAILABLE_BALANCE' using errcode = 'P0001';
  end if;
  if v_wallet.locked_balance + v_locked_delta < 0 then
    raise exception 'INSUFFICIENT_LOCKED_BALANCE' using errcode = 'P0001';
  end if;

  update public.wallets
     set available_balance = available_balance + v_avail_delta,
         locked_balance    = locked_balance + v_locked_delta
   where id = v_wallet.id
   returning * into v_wallet;

  insert into public.wallet_transactions (
    user_id, wallet_id, type, amount, currency, status, direction,
    available_delta, locked_delta, balance_after, reference, external_reference,
    description, metadata, source, created_by, completed_at
  ) values (
    p_user_id, v_wallet.id, p_type, p_amount, v_wallet.currency, p_status, v_direction,
    v_avail_delta, v_locked_delta, v_wallet.available_balance, p_reference, p_external_reference,
    p_description, coalesce(p_metadata, '{}'::jsonb), p_source, p_created_by,
    case when p_status = 'COMPLETED' then now() else null end
  )
  returning * into v_tx;

  return v_tx;
end;
$$;


-- ============================================================================
-- 7. video_start — a package video needs the package, and headroom
-- ============================================================================

create or replace function public.video_start(
  p_user_id     uuid,
  p_video_id    uuid,
  p_ip_hash     text default null,
  p_device_hash text default null
)
returns table (
  session_id             uuid,
  session_token          uuid,
  video_id               uuid,
  title                  text,
  description            text,
  video_url              text,
  thumbnail_url          text,
  duration_seconds       int,
  required_watch_seconds int,
  reward_amount          numeric,
  currency               text,
  started_at             timestamptz,
  watched_seconds        numeric,
  status                 text,
  resumed                boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
  v_video   public.videos;
  v_session public.video_watch_sessions;
  v_recent  int;
  v_velocity int;
  v_package_id uuid;
  v_usage   record;
begin
  select * into v_profile from public.profiles where id = p_user_id;
  if not found then
    raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_profile.status <> 'ACTIVE' then
    raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if v_profile.risk_status in ('RESTRICTED','SUSPENDED') then
    raise exception 'ACCOUNT_RESTRICTED' using errcode = 'P0001';
  end if;
  if public.setting_bool('security.require_email_verified_to_earn', false)
     and v_profile.email_verified_at is null then
    raise exception 'EMAIL_VERIFICATION_REQUIRED' using errcode = 'P0001';
  end if;

  select * into v_video from public.videos where id = p_video_id;
  if not found then
    raise exception 'VIDEO_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_video.status <> 'ACTIVE' then
    raise exception 'VIDEO_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
  if v_video.total_view_limit is not null and v_video.total_views >= v_video.total_view_limit then
    raise exception 'VIDEO_VIEW_LIMIT_REACHED' using errcode = 'P0001';
  end if;
  if not public.campaign_is_payable(v_video.campaign_id, v_video.reward_amount) then
    raise exception 'CAMPAIGN_NOT_PAYABLE' using errcode = 'P0001';
  end if;

  -- --------------------------------------------------------------------------
  -- NEW IN 0014: package gate.
  --
  -- A video in no package skips this entirely and behaves exactly as before.
  --
  -- Refusing to START (rather than letting the user watch and then rejecting the
  -- collect) is the whole point: a cap that has been reached is not an error
  -- condition, it is a wait, and the UI turns PACKAGE_DAILY_LIMIT_REACHED into a
  -- countdown to `package_daily_usage().resets_at`.
  -- --------------------------------------------------------------------------
  select pv.package_id into v_package_id
    from public.package_videos pv
   where pv.video_id = p_video_id;

  if v_package_id is not null then
    select * into v_usage from public.package_daily_usage(p_user_id, v_package_id);

    if not v_usage.has_active_purchase then
      /*
        A lapsed term gets its own code. "You need a package" is the wrong thing
        to tell someone who bought one and has simply run out of days — and on a
        tier sold as two weeks, that will be most of its buyers.
      */
      if v_usage.purchase_expired then
        raise exception 'PACKAGE_EXPIRED' using errcode = 'P0001';
      end if;
      raise exception 'PACKAGE_REQUIRED' using errcode = 'P0001';
    end if;
    if v_usage.daily_cap <= 0 then
      raise exception 'PACKAGE_NOT_AVAILABLE' using errcode = 'P0001';
    end if;
    if v_usage.earned_today >= v_usage.daily_cap then
      raise exception 'PACKAGE_DAILY_LIMIT_REACHED' using errcode = 'P0001';
    end if;
    /*
      The lifetime ceiling, checked at START as well as at collect. Once it is
      reached the package never pays again, so letting the user sit through a
      video that cannot be rewarded would waste their time for nothing — the same
      reason the daily cap is checked here.
    */
    if v_usage.lifetime_cap is not null and v_usage.earned_total >= v_usage.lifetime_cap then
      raise exception 'PACKAGE_TOTAL_LIMIT_REACHED' using errcode = 'P0001';
    end if;
  end if;

  -- Velocity guard: a human cannot legitimately finish many videos per hour.
  select count(*) into v_velocity
    from public.video_watch_sessions s
   where s.user_id = p_user_id
     and s.status = 'REWARDED'
     and s.rewarded_at > now() - interval '1 hour';
  if v_velocity >= greatest(1, public.setting_num('fraud.max_rewarded_sessions_per_hour', 40)::int) then
    perform public.record_fraud_event(
      p_user_id, 'WATCH_VELOCITY_EXCEEDED', 'MEDIUM', 15,
      jsonb_build_object('rewarded_last_hour', v_velocity, 'video_id', p_video_id)
    );
    raise exception 'VELOCITY_BLOCKED' using errcode = 'P0001';
  end if;

  -- Cooldown between watches of the same video.
  if public.setting_num('rewards.cooldown_seconds', 0) > 0 and exists (
    select 1 from public.video_watch_sessions s
     where s.user_id = p_user_id
       and s.video_id = p_video_id
       and s.status = 'REWARDED'
       and s.rewarded_at > now() - make_interval(secs => public.setting_num('rewards.cooldown_seconds', 0)::int)
  ) then
    raise exception 'VIDEO_COOLDOWN_ACTIVE' using errcode = 'P0001';
  end if;

  -- Daily per-video limit.
  select count(*) into v_recent
    from public.video_watch_sessions s
   where s.user_id = p_user_id
     and s.video_id = p_video_id
     and s.status = 'REWARDED'
     and s.rewarded_at >= date_trunc('day', now());
  if v_video.daily_limit > 0 and v_recent >= v_video.daily_limit then
    raise exception 'VIDEO_DAILY_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  -- Resume an in-flight session instead of stacking duplicates.
  select * into v_session
    from public.video_watch_sessions s
   where s.user_id = p_user_id
     and s.video_id = p_video_id
     and s.status in ('STARTED','WATCHING')
     and s.started_at > now() - interval '40 minutes'
   order by s.started_at desc
   limit 1;

  if found then
    update public.video_watch_sessions
       set last_activity_at = now(),
           status = 'WATCHING',
           -- Re-stamp the package, so a session started before this migration
           -- (or before the video was added to a tier) is attributed correctly.
           package_id = coalesce(v_package_id, package_id)
     where id = v_session.id
     returning * into v_session;

    return query
      select v_session.id, v_session.session_token, v_video.id, v_video.title, v_video.description,
             v_video.video_url, v_video.thumbnail_url, v_video.duration_seconds,
             v_session.required_watch_seconds, v_video.reward_amount, v_video.currency,
             v_session.started_at, v_session.watched_seconds, v_session.status, true;
    return;
  end if;

  insert into public.video_watch_sessions (
    user_id, video_id, required_watch_seconds, ip_hash, device_hash, status, package_id
  ) values (
    p_user_id, p_video_id, v_video.required_watch_seconds, p_ip_hash, p_device_hash, 'WATCHING', v_package_id
  )
  returning * into v_session;

  return query
    select v_session.id, v_session.session_token, v_video.id, v_video.title, v_video.description,
           v_video.video_url, v_video.thumbnail_url, v_video.duration_seconds,
           v_video.required_watch_seconds, v_video.reward_amount, v_video.currency,
           v_session.started_at, v_session.watched_seconds, v_session.status, false;
end;
$$;

revoke all on function public.video_start(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.video_start(uuid, uuid, text, text) to service_role;


-- ============================================================================
-- 8. video_complete_session — the package cap, re-checked under the lock
--
-- Copy of 0010's definition with ONE insertion, marked below. Every existing
-- gate keeps its original order and meaning.
-- ============================================================================

create or replace function public.video_complete_session(
  p_user_id       uuid,
  p_session_token uuid
)
returns table (
  result_status   text,
  reward_amount   numeric,
  currency        text,
  transaction_id  uuid,
  reference       text,
  watched_seconds numeric,
  reject_reason   text,
  duplicate       boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session  public.video_watch_sessions;
  v_video    public.videos;
  v_profile  public.profiles;
  v_elapsed  numeric;
  v_reward   numeric(20,4);
  v_tx       public.wallet_transactions;
  v_daily    int;
  v_ref      text;
  v_usage    record;
begin
  perform pg_advisory_xact_lock(hashtext('session:' || p_session_token::text));

  select * into v_session
    from public.video_watch_sessions
   where session_token = p_session_token and user_id = p_user_id
   for update;

  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_video from public.videos where id = v_session.video_id;
  select * into v_profile from public.profiles where id = p_user_id;

  -- Idempotent: a session rewards exactly once, ever.
  if v_session.status = 'REWARDED' and v_session.reward_transaction_id is not null then
    return query
      select 'REWARDED', v_session.reward_amount, v_video.currency, v_session.reward_transaction_id,
             v_session.reward_reference, v_session.watched_seconds, null::text, true;
    return;
  end if;
  if v_session.status in ('EXPIRED','REJECTED','SUSPENDED') then
    return query
      select v_session.status, null::numeric, v_video.currency, null::uuid, null::text,
             v_session.watched_seconds, v_session.reject_reason, false;
    return;
  end if;

  -- A session already completed without a reward is terminal too, so collecting
  -- twice cannot count the same view twice. This is the only place that sets
  -- 'COMPLETED', so the status is unambiguous.
  if v_session.status = 'COMPLETED' then
    return query
      select 'NO_REWARD', v_session.reward_amount, v_video.currency, null::uuid, null::text,
             v_session.watched_seconds, null::text, true;
    return;
  end if;

  v_elapsed := extract(epoch from (now() - v_session.started_at));

  -- Watch-time enforcement happens server-side only.
  if v_elapsed < v_session.required_watch_seconds or v_session.watched_seconds < v_session.required_watch_seconds then
    update public.video_watch_sessions
       set status = 'REJECTED',
           reject_reason = 'INSUFFICIENT_WATCH_TIME',
           completed_at = now()
     where id = v_session.id;

    perform public.record_fraud_event(
      p_user_id, 'WATCH_TIME_MISMATCH', 'LOW', 5,
      jsonb_build_object('session_id', v_session.id, 'watched', v_session.watched_seconds,
                         'required', v_session.required_watch_seconds, 'elapsed', v_elapsed)
    );

    return query
      select 'REJECTED', null::numeric, v_video.currency, null::uuid, null::text,
             v_session.watched_seconds, 'INSUFFICIENT_WATCH_TIME', false;
    return;
  end if;

  if v_profile.status <> 'ACTIVE' or v_profile.risk_status in ('RESTRICTED','SUSPENDED') then
    update public.video_watch_sessions
       set status = 'SUSPENDED', reject_reason = 'ACCOUNT_NOT_ELIGIBLE', completed_at = now()
     where id = v_session.id;
    return query
      select 'SUSPENDED', null::numeric, v_video.currency, null::uuid, null::text,
             v_session.watched_seconds, 'ACCOUNT_NOT_ELIGIBLE', false;
    return;
  end if;

  -- Lock the campaign row *before* deciding, so two sessions completing at the
  -- same instant cannot both pass the budget check and jointly overspend it.
  if v_video.campaign_id is not null then
    perform 1 from public.video_campaigns where id = v_video.campaign_id for update;
  end if;

  -- Campaign budget / view ceiling.
  if v_video.status <> 'ACTIVE' or not public.campaign_is_payable(v_video.campaign_id, v_video.reward_amount) then
    update public.video_watch_sessions
       set status = 'REJECTED', reject_reason = 'CAMPAIGN_BUDGET_EXHAUSTED', completed_at = now()
     where id = v_session.id;
    return query
      select 'REJECTED', null::numeric, v_video.currency, null::uuid, null::text,
             v_session.watched_seconds, 'CAMPAIGN_BUDGET_EXHAUSTED', false;
    return;
  end if;

  -- Platform-wide daily cap per user.
  select count(*) into v_daily
    from public.video_watch_sessions s
   where s.user_id = p_user_id
     and s.status = 'REWARDED'
     and s.rewarded_at >= date_trunc('day', now());
  if v_daily >= public.setting_num('rewards.max_daily_rewarded_sessions', 200) then
    update public.video_watch_sessions
       set status = 'REJECTED', reject_reason = 'DAILY_REWARD_LIMIT', completed_at = now()
     where id = v_session.id;
    return query
      select 'REJECTED', null::numeric, v_video.currency, null::uuid, null::text,
             v_session.watched_seconds, 'DAILY_REWARD_LIMIT', false;
    return;
  end if;

  -- --------------------------------------------------------------------------
  -- NEW IN 0014: the package's daily earning cap.
  --
  -- Placed after every existing gate so a package video is held to exactly the
  -- same watch-time, account, campaign and platform rules as any other.
  --
  -- `earned_today + reward > cap` rather than `earned_today >= cap`: the reward
  -- that would take the user *past* the cap is refused whole. Paying a prorated
  -- remnant would put a partial amount in the ledger that no campaign figure
  -- explains, and would let the cap be exceeded one reward at a time.
  --
  -- A session that reaches here is in a genuine race — the same video was
  -- started while there was headroom and another session consumed it first. It is
  -- rejected WITHOUT a fraud event, exactly like the platform daily cap above:
  -- reaching a limit is not misbehaviour.
  -- --------------------------------------------------------------------------
  if v_session.package_id is not null then
    select * into v_usage from public.package_daily_usage(p_user_id, v_session.package_id);

    if not v_usage.has_active_purchase then
      update public.video_watch_sessions
         set status = 'REJECTED',
             reject_reason = case
                               when v_usage.purchase_expired then 'PACKAGE_EXPIRED'
                               else 'PACKAGE_REQUIRED'
                             end,
             completed_at = now()
       where id = v_session.id;
      return query
        select 'REJECTED', null::numeric, v_video.currency, null::uuid, null::text,
               v_session.watched_seconds,
               case
                 when v_usage.purchase_expired then 'PACKAGE_EXPIRED'
                 else 'PACKAGE_REQUIRED'
               end,
               false;
      return;
    end if;

    if v_usage.earned_today + v_video.reward_amount > v_usage.daily_cap then
      update public.video_watch_sessions
         set status = 'REJECTED', reject_reason = 'PACKAGE_DAILY_LIMIT', completed_at = now()
       where id = v_session.id;
      return query
        select 'REJECTED', null::numeric, v_video.currency, null::uuid, null::text,
               v_session.watched_seconds, 'PACKAGE_DAILY_LIMIT', false;
      return;
    end if;

    /*
      The lifetime ceiling, refused whole for the same reason as the daily one: a
      prorated remnant would put an amount in the ledger that no advertised term
      explains, and would let the ceiling be exceeded one reward at a time.
    */
    if v_usage.lifetime_cap is not null
       and v_usage.earned_total + v_video.reward_amount > v_usage.lifetime_cap then
      update public.video_watch_sessions
         set status = 'REJECTED', reject_reason = 'PACKAGE_TOTAL_LIMIT', completed_at = now()
       where id = v_session.id;
      return query
        select 'REJECTED', null::numeric, v_video.currency, null::uuid, null::text,
               v_session.watched_seconds, 'PACKAGE_TOTAL_LIMIT', false;
      return;
    end if;
  end if;

  -- The reward value is read from the campaign record — never from the client.
  v_reward := v_video.reward_amount;
  v_ref := 'VRW-' || v_session.id::text;

  -- --------------------------------------------------------------------------
  -- NEW IN 0010: a reward of zero completes without touching the ledger.
  --
  -- Deliberately placed after every gate above, so a zero-reward session is
  -- held to the same watch-time, account, campaign and daily-limit rules as a
  -- paying one. It is not an early exit and cannot be used to skip a check.
  -- --------------------------------------------------------------------------
  if v_reward is null or v_reward = 0 then
    update public.video_watch_sessions
       set status = 'COMPLETED',
           completed_at = now(),
           reward_amount = 0
     where id = v_session.id;

    -- The view still happened, so campaign accounting still counts it.
    update public.videos
       set total_views = total_views + 1
     where id = v_video.id;

    if v_video.campaign_id is not null then
      update public.video_campaigns
         set total_views = total_views + 1
       where id = v_video.campaign_id;
    end if;

    return query
      select 'NO_REWARD', 0::numeric, v_video.currency, null::uuid, null::text,
             v_session.watched_seconds, null::text, false;
    return;
  end if;

  v_tx := public.wallet_post(
    p_user_id     => p_user_id,
    p_type        => 'VIDEO_REWARD',
    p_amount      => v_reward,
    p_status      => 'COMPLETED',
    p_reference   => v_ref,
    p_description => 'Reward for completed video: ' || v_video.title,
    p_metadata    => jsonb_build_object(
                       'video_id', v_video.id,
                       'campaign_id', v_video.campaign_id,
                       'session_id', v_session.id,
                       'package_id', v_session.package_id
                     ),
    p_source      => 'VIDEO'
  );

  update public.video_watch_sessions
     set status = 'REWARDED',
         completed_at = now(),
         rewarded_at = now(),
         reward_amount = v_reward,
         reward_transaction_id = v_tx.id,
         reward_reference = v_ref
   where id = v_session.id;

  -- Campaign accounting so budget can never be silently exceeded.
  update public.videos
     set total_views = total_views + 1
   where id = v_video.id;

  if v_video.campaign_id is not null then
    update public.video_campaigns
       set spent = spent + v_reward,
           total_views = total_views + 1
     where id = v_video.campaign_id
       and spent + v_reward <= budget;

    -- If the ceiling moved while we were paying, roll the whole thing back
    -- rather than crediting a reward the campaign budget cannot cover.
    if not found then
      raise exception 'CAMPAIGN_NOT_PAYABLE' using errcode = 'P0001';
    end if;
  end if;

  perform public.notify_user(
    p_user_id, 'VIDEO_REWARD_CREDITED', 'Reward credited',
    'Your reward of ' || v_video.currency || ' ' || to_char(v_reward, 'FM999,999,990.00') ||
      ' for "' || v_video.title || '" has been added to your wallet.',
    'SUCCESS', '/dashboard/wallet'
  );

  return query
    select 'REWARDED', v_reward, v_video.currency, v_tx.id, v_ref, v_session.watched_seconds, null::text, false;
end;
$$;

revoke all on function public.video_complete_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.video_complete_session(uuid, uuid) to service_role;


-- ============================================================================
-- 9. row level security
--
-- Same rule as every other table in this schema: the browser may READ, never
-- write. All three tables are administered through /api/admin/packages with the
-- service role.
-- ============================================================================

alter table public.packages      enable row level security;
alter table public.package_videos enable row level security;
alter table public.user_packages  enable row level security;

-- The catalogue: published tiers only.
drop policy if exists packages_select_active on public.packages;
create policy packages_select_active on public.packages
  for select to authenticated
  using (status = 'ACTIVE');

-- Which videos a tier unlocks. Readable when the package itself is published —
-- the video ids are not secret and the watch page needs them to mark a video as
-- "in a package you do not own yet".
drop policy if exists package_videos_select_active on public.package_videos;
create policy package_videos_select_active on public.package_videos
  for select to authenticated
  using (
    exists (
      select 1 from public.packages p
       where p.id = package_id and p.status = 'ACTIVE'
    )
  );

-- A user's own purchases, and nobody else's.
drop policy if exists user_packages_select_own on public.user_packages;
create policy user_packages_select_own on public.user_packages
  for select to authenticated
  using (user_id = public.current_profile_id());

-- RLS already denies every write (no policy permits one); revoking the privilege
-- as well means a future policy mistake cannot quietly open a write path.
revoke insert, update, delete, truncate on public.packages       from anon, authenticated;
revoke insert, update, delete, truncate on public.package_videos from anon, authenticated;
revoke insert, update, delete, truncate on public.user_packages  from anon, authenticated;

grant select on public.packages      to authenticated;
grant select on public.package_videos to authenticated;
grant select on public.user_packages  to authenticated;

-- SELECT is revoked from anon EXPLICITLY rather than left to the absence of a
-- grant. Supabase applies default privileges to new tables in the public schema,
-- so "we never granted it" is not the same as "it cannot read this" — without
-- this line an anonymous caller would still reach the table and only RLS would
-- be standing between it and the rows.
revoke select on public.packages       from anon;
revoke select on public.package_videos  from anon;
revoke select on public.user_packages   from anon;


-- ============================================================================
-- 10. the operator's tier list
--
-- THE SEEDED TIERS, AND THE TERMS THEY ARE SOLD ON
--
-- Ten prices from the operator (800 / 2,500 / 5,000 / 7,500 / 12,000 / 15,000 /
-- 20,000 / 25,000 / 50,000 / 70,000 KES), each with the three figures that decide
-- what it can pay:
--
--   · daily_earning_cap    — the most its videos can pay in one calendar day
--   · lifetime_earning_cap — the most one purchase can ever pay, in total
--   · duration_days        — how long a purchase stays earnable
--
-- The daily figure follows one rule from the operator's entry tier: 68 per 800
-- KES per day. Every tier runs for 14 days, so the total is 14 days at that
-- tier's daily cap — except the 800 tier, whose total is the round 950 that was
-- specified rather than the 952 that 14 full days would allow.
--
-- The inserted tiers are ACTIVE, because the terms above are the operator's. What
-- is still outstanding is the videos: a package pays only from the videos
-- attached to it (Admin -> Packages -> attach videos), and a tier with none
-- attached takes the money and pays nothing. The descriptions say exactly what
-- the caps are and never what the package will pay — the daily figure is a
-- ceiling funded by campaign budgets, not an amount the platform owes.
--
-- This runs as a loop rather than an `insert … select` because the catalogue may
-- already exist: an `apply-all.sql` generated before these terms were specified
-- would have created the same tiers as DRAFT placeholders with no cap, and a
-- plain insert would then skip them and leave the operator with ten packages that
-- cannot be bought. Each tier is therefore upgraded only when it is provably
-- untouched — still DRAFT, still capped at 0, and never purchased — so a tier the
-- operator has configured, or that anybody has bought, is left exactly as it is.
-- ============================================================================

do $$
declare
  v_tier record;
begin
  for v_tier in
    select * from (values
      ('Package 800',    800::numeric,   68::numeric,   950::numeric, 14,  10),
      ('Package 2500',  2500::numeric,  213::numeric,  2982::numeric, 14,  20),
      ('Package 5000',  5000::numeric,  425::numeric,  5950::numeric, 14,  30),
      ('Package 7500',  7500::numeric,  638::numeric,  8932::numeric, 14,  40),
      ('Package 12000',12000::numeric, 1020::numeric, 14280::numeric, 14,  50),
      ('Package 15000',15000::numeric, 1275::numeric, 17850::numeric, 14,  60),
      ('Package 20000',20000::numeric, 1700::numeric, 23800::numeric, 14,  70),
      ('Package 25000',25000::numeric, 2125::numeric, 29750::numeric, 14,  80),
      ('Package 50000',50000::numeric, 4250::numeric, 59500::numeric, 14,  90),
      ('Package 70000',70000::numeric, 5950::numeric, 83300::numeric, 14, 100)
    ) as seed(name, price, daily_cap, lifetime_cap, days, sort_order)
  loop
    update public.packages p
       set price                = v_tier.price,
           daily_earning_cap    = v_tier.daily_cap,
           lifetime_earning_cap = v_tier.lifetime_cap,
           duration_days        = v_tier.days,
           description          = format(
             'Up to KES %s per day from this package''s videos, up to KES %s in total, for %s days.',
             to_char(v_tier.daily_cap, 'FM999,999,990'),
             to_char(v_tier.lifetime_cap, 'FM999,999,990'),
             v_tier.days
           ),
           status               = 'ACTIVE',
           updated_at           = now()
     where p.name = v_tier.name
       and p.status = 'DRAFT'
       and p.daily_earning_cap = 0
       and not exists (
             select 1 from public.user_packages up where up.package_id = p.id
           );

    if not exists (select 1 from public.packages p where p.name = v_tier.name) then
      insert into public.packages (
        name, description, price, currency, daily_earning_cap,
        lifetime_earning_cap, duration_days, status, sort_order
      ) values (
        v_tier.name,
        format(
          'Up to KES %s per day from this package''s videos, up to KES %s in total, for %s days.',
          to_char(v_tier.daily_cap, 'FM999,999,990'),
          to_char(v_tier.lifetime_cap, 'FM999,999,990'),
          v_tier.days
        ),
        v_tier.price, 'KES', v_tier.daily_cap,
        v_tier.lifetime_cap, v_tier.days, 'ACTIVE', v_tier.sort_order
      );
    end if;
  end loop;
end $$;


-- ============================================================================
-- A NOTE THAT BELONGS WITH THE SCHEMA, NOT IN A CHAT MESSAGE
--
-- A package takes money from a user and gives them a bounded daily earning
-- allowance. That is a very different product from advertising, and the platform
-- funds it out of its own revenue: nothing in this schema creates money, and
-- every reward is still a real ledger credit that some real inflow has to cover.
--
-- Two consequences the operator owns:
--
--   · Withdrawals can only be paid from money that has actually arrived. If the
--     daily caps across all sold packages exceed the platform's real revenue,
--     the shortfall shows up as withdrawals that cannot settle. Track it:
--     sum(daily_earning_cap) x active users is the platform's worst-case daily
--     liability.
--
--   · The lifetime ceiling bounds one purchase, not the platform. Ten sales of the
--     70,000 tier are 833,000 of ceiling — against 700,000 of income if every
--     buyer paid full price, and that is before any deposit bonus is credited on
--     top (0015). The term does not change this arithmetic: 14 days is
--     long enough to reach the whole ceiling, so the ceiling is the figure that
--     has to be funded.
--
--   · The UI must never imply a return, a payback period or a projected income.
--     "Earn up to X per day from this package's videos" is the factual claim;
--     "recoup your package" is not, and the terms and rewards policy have to say
--     which one this is. Stating a ceiling and a term is not the same as
--     promising them, which is why `duration_days` is described as how long the
--     purchase stays earnable rather than what it will earn.
-- ============================================================================
