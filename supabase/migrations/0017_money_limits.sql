-- ============================================================================
-- 0017 — Money limits: deposit bounds, and a withdrawal ceiling that rises with
--        the package a user holds
-- ============================================================================
--
-- Requested as: "minimum withdrawal 100, max is 1000, it increases as per
-- package; deposit minimum is 800, max 99000".
--
-- The minimum (100) and the per-currency maximum already existed as columns
-- (0001), enforced inside withdrawal_reserve (0002). What did not exist:
--
--   · a maximum DEPOSIT — `currencies` had a floor and no ceiling, so the only
--     bound on a deposit was what the payment provider would accept;
--   · a withdrawal ceiling that depends on what the user BOUGHT. `max_withdrawal`
--     is per currency, so it cannot rise with a package without everyone sharing
--     the highest tier's ceiling.
--
-- Both live here rather than in 0014 because `currencies` and the withdrawal
-- functions are already applied in production (0001–0007): editing an applied
-- migration would change nothing there.
-- ============================================================================


-- ============================================================================
-- 1. a ceiling on deposits
-- ============================================================================

alter table public.currencies
  add column if not exists max_deposit numeric(20,4);

-- NULL means "no ceiling", and 0 is refused: a ceiling of zero would be a
-- currency nobody can deposit into, which is a configuration mistake rather than
-- a policy. The column is nullable precisely so "no limit" is expressible without
-- borrowing 0 for it.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'currencies_max_deposit_positive'
  ) then
    alter table public.currencies
      add constraint currencies_max_deposit_positive
      check (max_deposit is null or max_deposit > 0);
  end if;
end $$;

comment on column public.currencies.max_deposit is
  'Largest single deposit accepted, or NULL for no ceiling. Enforced in the deposit service before a provider is contacted.';


-- ============================================================================
-- 2. the operator's figures for KES
-- ============================================================================

/*
  min_deposit 800 / max_deposit 99,000, and the withdrawal floor stays 100.

  max_withdrawal is deliberately left as the ABSOLUTE ceiling it already is, not
  set to 1,000: the per-package ceiling below is what a user actually sees, and it
  tops out at 87,500 (the 70,000 tier), so lowering the currency ceiling to 1,000
  would silently cap every larger package at 1,000 instead of 87,500.
*/
update public.currencies
   set min_deposit = 800,
       max_deposit = 99000,
       min_withdrawal = 100
 where code = 'KES';

-- The platform-wide dial is moved to the same figures, so the admin panel and
-- the currency column cannot disagree about what a deposit ceiling is. The
-- service takes the lower of the two, so this one can only ever tighten.
insert into public.system_settings (key, value, type, category, description, is_public)
values
  ('deposits.max_amount', '99000'::jsonb, 'number', 'deposits',
   'Largest single deposit accepted platform-wide. The effective ceiling is the lower of this and the currency''s own maximum.',
   false)
on conflict (key) do update set value = excluded.value;

-- The ceiling for someone who holds no package: the operator's 1,000.
insert into public.system_settings (key, value, type, category, description, is_public)
values
  ('withdrawals.default_max', '1000'::jsonb, 'number', 'withdrawals',
   'Withdrawal ceiling for an account with no active package. A package can only raise this, never lower it.',
   false)
on conflict (key) do update set value = excluded.value;


-- ============================================================================
-- 3. a ceiling on the package itself
-- ============================================================================

alter table public.packages
  add column if not exists max_withdrawal numeric(20,4);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'packages_max_withdrawal_positive'
  ) then
    alter table public.packages
      add constraint packages_max_withdrawal_positive
      check (max_withdrawal is null or max_withdrawal > 0);
  end if;
end $$;

comment on column public.packages.max_withdrawal is
  'Most this package lets its holder withdraw in one request. NULL falls back to withdrawals.default_max. The effective ceiling is the highest among the packages a user currently holds.';

/*
  Priced at 1.25 x the package price, which is what produces the operator's
  headline figure: the 800 tier becomes exactly 1,000.

  Set here rather than in 0014's seed so that it also lands on a catalogue that
  0014 already created — 0014 only inserts tiers it cannot find, and this is an
  update to rows that exist either way. A tier the operator has since given an
  explicit ceiling is left alone.
*/
update public.packages
   set max_withdrawal = round(price * 1.25, 2),
       updated_at = now()
 where max_withdrawal is null
   and price > 0;


-- ============================================================================
-- 4. the effective ceiling for one user
-- ============================================================================

create or replace function public.user_withdrawal_max(p_user_id uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_currency_max numeric;
  v_default_max  numeric;
  v_package_max  numeric;
begin
  select c.max_withdrawal into v_currency_max
    from public.profiles p
    join public.currencies c on c.code = p.currency
   where p.id = p_user_id;

  v_default_max := public.setting_num('withdrawals.default_max', 1000);

  -- An unknown profile or currency leaves only the default, which is the safe
  -- direction: the caller is refused rather than given the currency ceiling.
  if v_currency_max is null then
    return v_default_max;
  end if;

  /*
    The highest ceiling among the packages they hold RIGHT NOW. Lapsed and revoked
    purchases are excluded for the same reason every other cap check excludes them:
    a purchase that has run out is not a licence to withdraw more.

    `greatest(default, package)` rather than `coalesce`: a package may only raise
    the ceiling. A tier priced below the default would otherwise LOWER a user's
    limit, which is the opposite of what was asked for.
  */
  select max(pk.max_withdrawal) into v_package_max
    from public.user_packages up
    join public.packages pk on pk.id = up.package_id
   where up.user_id = p_user_id
     and up.status = 'ACTIVE'
     and (up.expires_at is null or up.expires_at > now())
     and pk.max_withdrawal is not null;

  return least(v_currency_max, greatest(v_default_max, coalesce(v_package_max, 0)));
end;
$$;

revoke all on function public.user_withdrawal_max(uuid) from public, anon, authenticated;
grant execute on function public.user_withdrawal_max(uuid) to service_role;

comment on function public.user_withdrawal_max(uuid) is
  'The largest single withdrawal this user may request: their highest active package ceiling, floored by withdrawals.default_max and capped by the currency.';


-- ============================================================================
-- 5. the withdrawal path uses it
-- ============================================================================
--
-- Reproduced in full from 0002 with exactly two changes: the maximum is the
-- user's own ceiling instead of the currency's, and the rolling 24-hour limit
-- defaults to that same ceiling rather than to the currency's. Everything else —
-- the idempotency lock, the KYC/age/pending gates, the fee check, the
-- available -> locked reserve — is byte-for-byte the 0002 behaviour, because this
-- function moves money and a rewrite is a place for a mistake.

create or replace function public.withdrawal_reserve(
  p_user_id         uuid,
  p_amount          numeric,
  p_phone           text,
  p_idempotency_key text,
  p_fee             numeric default null,
  p_risk_score      int default 0
)
returns public.withdrawals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
  v_wallet  public.wallets;
  v_currency public.currencies;
  v_existing public.withdrawals;
  v_fee     numeric(20,4);
  v_pending int;
  v_withdrawal public.withdrawals;
  v_daily numeric(20,4);
  v_user_max numeric(20,4);
begin
  perform pg_advisory_xact_lock(hashtext('withdraw:' || p_idempotency_key));

  -- Idempotent replay of the same submission.
  select * into v_existing from public.withdrawals where idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

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
  if public.setting_bool('withdrawals.require_verified_kyc', false)
     and v_profile.kyc_status <> 'VERIFIED' then
    raise exception 'KYC_REQUIRED' using errcode = 'P0001';
  end if;

  select * into v_currency from public.currencies where code = v_profile.currency;
  if not found or not v_currency.enabled then
    raise exception 'CURRENCY_NOT_SUPPORTED' using errcode = 'P0001';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'WITHDRAWAL_AMOUNT_INVALID' using errcode = '22023';
  end if;
  if p_amount < v_currency.min_withdrawal then
    raise exception 'WITHDRAWAL_BELOW_MINIMUM' using errcode = 'P0001';
  end if;

  -- NEW IN 0017: the ceiling is this user's, not the currency's.
  v_user_max := public.user_withdrawal_max(p_user_id);
  if p_amount > v_user_max then
    raise exception 'WITHDRAWAL_ABOVE_MAXIMUM' using errcode = 'P0001';
  end if;

  -- Account age gate.
  if v_profile.created_at > now() - make_interval(hours => greatest(0, public.setting_num('withdrawals.min_account_age_hours', 0)::int)) then
    raise exception 'ACCOUNT_TOO_NEW' using errcode = 'P0001';
  end if;

  -- Only one in-flight withdrawal per user at a time by default.
  select count(*) into v_pending
    from public.withdrawals
   where user_id = p_user_id
     and status in ('PENDING_ADMIN_APPROVAL','APPROVED','PROCESSING');
  if v_pending >= greatest(1, public.setting_num('withdrawals.max_pending_requests', 1)::int) then
    raise exception 'PENDING_WITHDRAWAL_EXISTS' using errcode = 'P0001';
  end if;

  -- Rolling 24h volume limit. NEW IN 0017: its default is the user's ceiling, so
  -- the ceiling is a per-day figure rather than something a user can request
  -- repeatedly at one request at a time.
  select coalesce(sum(amount), 0) into v_daily
    from public.withdrawals
   where user_id = p_user_id
     and status not in ('REJECTED','FAILED','CANCELLED')
     and requested_at > now() - interval '24 hours';
  if v_daily + p_amount > public.setting_num('withdrawals.daily_limit', v_user_max) then
    raise exception 'WITHDRAWAL_DAILY_LIMIT_EXCEEDED' using errcode = 'P0001';
  end if;

  v_fee := coalesce(p_fee, v_currency.withdrawal_fee);
  if v_fee < 0 or v_fee >= p_amount then
    raise exception 'WITHDRAWAL_FEE_INVALID' using errcode = '22023';
  end if;

  -- Lock the wallet, then reserve the funds: available -> locked.
  select * into v_wallet from public.wallets where user_id = p_user_id for update;
  if not found then
    raise exception 'WALLET_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_wallet.available_balance < p_amount then
    raise exception 'INSUFFICIENT_AVAILABLE_BALANCE' using errcode = 'P0001';
  end if;

  insert into public.withdrawals (
    user_id, wallet_id, amount, fee, net_amount, currency, phone, status,
    risk_score, idempotency_key, provider, requested_at
  ) values (
    p_user_id, v_wallet.id, p_amount, v_fee, p_amount - v_fee, v_wallet.currency,
    p_phone, 'PENDING_ADMIN_APPROVAL', greatest(0, least(100, coalesce(p_risk_score, 0))),
    p_idempotency_key, 'SASAPAY', now()
  )
  returning * into v_withdrawal;

  perform public.wallet_post(
    p_user_id    => p_user_id,
    p_type       => 'WITHDRAWAL_HOLD',
    p_amount     => p_amount,
    p_status     => 'COMPLETED',
    p_reference  => 'WHL-' || v_withdrawal.id::text,
    p_description => 'Withdrawal request held pending administrator approval',
    p_metadata   => jsonb_build_object('withdrawal_id', v_withdrawal.id, 'phone', p_phone),
    p_source     => 'WALLET'
  );

  perform public.notify_user(
    p_user_id, 'WITHDRAWAL_SUBMITTED', 'Withdrawal request submitted',
    'Your withdrawal request of ' || v_wallet.currency || ' ' || to_char(p_amount, 'FM999,999,990.00') ||
      ' is pending review by the TaskCash Pro administration team.',
    'INFO', '/dashboard/withdraw'
  );

  return v_withdrawal;
end;
$$;

revoke all on function public.withdrawal_reserve(uuid, numeric, text, text, numeric, int) from public, anon, authenticated;
grant execute on function public.withdrawal_reserve(uuid, numeric, text, text, numeric, int) to service_role;
