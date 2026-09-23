-- ============================================================================
-- TaskCash Pro — 0026 withdrawal fee as a percentage of the request
--
-- WHAT CHANGES
-- ------------
-- Until now the withdrawal fee was a FLAT amount per currency
-- (`currencies.withdrawal_fee`), seeded at 0, and `withdrawal_reserve` charged
-- it verbatim:
--
--     v_fee := coalesce(p_fee, v_currency.withdrawal_fee);
--
-- The business rule is now a PERCENTAGE of the amount requested: a 10% fee on
-- every withdrawal, taken out of the request, so the user receives the
-- remainder. Requesting 1,000 means a 100 fee and 900 paid out.
--
-- WHY A NEW COLUMN INSTEAD OF REPURPOSING `withdrawal_fee`
-- -------------------------------------------------------
-- `withdrawal_fee` is a flat amount, and the name, the type and the column
-- comment all say so. Storing 10 in it would mean "10 shillings" to every
-- existing reader — including the withdrawal preview, which formats it as
-- money — while meaning "10 per cent" here. Two meanings in one column is how a
-- fee silently becomes wrong later.
--
-- So the percentage is its own column, and the flat fee keeps working:
--
--     percentage > 0  ->  fee = round(amount * percentage / 100, 2)
--     percentage = 0  ->  fee = the existing flat `withdrawal_fee`
--
-- A currency with no percentage configured therefore behaves exactly as it does
-- today, which keeps this migration reversible by setting the column back to 0.
--
-- ROUNDING IS PART OF THE RULE
-- ----------------------------
-- `round(x, 2)` on a `numeric` in Postgres is exact decimal rounding, not a
-- float approximation, so the charge agrees with the figure the user was shown
-- before confirming. The client mirrors this formula in
-- `src/lib/money/withdrawal-fee.ts`; if either side changes, both must.
--
-- THE FEE IS STILL VALIDATED
-- --------------------------
-- The existing guard is kept and still applies to the computed figure:
--
--     if v_fee < 0 or v_fee >= p_amount then raise 'WITHDRAWAL_FEE_INVALID'
--
-- A fee that would swallow the whole request is refused rather than paying out
-- zero. At 10% against the KES minimum of 100 that cannot be reached (the fee
-- is 10), but the guard is what stops a mis-set percentage from doing it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The percentage itself
-- ---------------------------------------------------------------------------
alter table public.currencies
  add column if not exists withdrawal_fee_percent numeric(20,4) not null default 0
    check (withdrawal_fee_percent >= 0 and withdrawal_fee_percent <= 100);

comment on column public.currencies.withdrawal_fee_percent is
  'Percentage of the requested amount charged as a withdrawal fee. When greater than 0 it takes precedence over the flat withdrawal_fee column. 0 disables percentage charging.';

-- ---------------------------------------------------------------------------
-- 2. Charge 10% on every withdrawal
--
-- Applied to every row, not only the enabled ones: this is a platform-wide
-- rule, and a currency that is switched on later should not quietly start
-- paying out fee-free because its row predates the change.
-- ---------------------------------------------------------------------------
update public.currencies
   set withdrawal_fee_percent = 10
 where withdrawal_fee_percent = 0;

-- ---------------------------------------------------------------------------
-- 3. Reproduced in full from 0017 with exactly one change: how `v_fee` is
--    derived. Every other line — the idempotency lock, the KYC/age/pending
--    gates, the 24-hour limit, the available -> locked reserve, the ledger
--    entry and the notification — is unchanged, because this function moves
--    money and a rewrite is a place for a mistake.
-- ---------------------------------------------------------------------------
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

  -- The ceiling is this user's, not the currency's.
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

  -- Rolling 24h volume limit, measured on the requested amount. The fee is a
  -- cost of the request, not a reduction of it, so a user cannot use the fee to
  -- fit more requests inside the limit than the limit allows.
  select coalesce(sum(amount), 0) into v_daily
    from public.withdrawals
   where user_id = p_user_id
     and status not in ('REJECTED','FAILED','CANCELLED')
     and requested_at > now() - interval '24 hours';
  if v_daily + p_amount > public.setting_num('withdrawals.daily_limit', v_user_max) then
    raise exception 'WITHDRAWAL_DAILY_LIMIT_EXCEEDED' using errcode = 'P0001';
  end if;

  -- CHANGED IN 0026: a configured percentage takes precedence over the flat fee.
  -- `p_fee` still wins when the application passes one explicitly, so the
  -- existing call path is unaffected.
  v_fee := coalesce(
    p_fee,
    case
      when v_currency.withdrawal_fee_percent > 0
        then round(p_amount * v_currency.withdrawal_fee_percent / 100, 2)
      else v_currency.withdrawal_fee
    end
  );

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

  -- `amount` stays the gross the user requested and that leaves their available
  -- balance; `net_amount` is what the provider is asked to pay out. The hold
  -- below is for the gross, because the whole request leaves `available` while
  -- the payout and the fee are settled from `locked`.
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

  -- The notification names the fee whenever one is charged, so the amount that
  -- arrives is never a surprise after the fact.
  perform public.notify_user(
    p_user_id, 'WITHDRAWAL_SUBMITTED', 'Withdrawal request submitted',
    'Your withdrawal request of ' || v_wallet.currency || ' ' || to_char(p_amount, 'FM999,999,990.00') ||
      case
        when v_fee > 0 then
          ' has a fee of ' || v_wallet.currency || ' ' || to_char(v_fee, 'FM999,999,990.00') ||
          ', so you will receive ' || v_wallet.currency || ' ' || to_char(p_amount - v_fee, 'FM999,999,990.00') || '.'
        else '.'
      end ||
      ' It is pending review by the TaskCash Pro administration team.',
    'INFO', '/dashboard/withdraw'
  );

  return v_withdrawal;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Re-assert the lock.
--
-- `create or replace` keeps the existing ACL, and 0023 already revoked client
-- EXECUTE from this function by name, so this is belt to that braces: it holds
-- even if this migration is ever applied to a database that predates 0023, and
-- it states the intent where the money rule is defined.
-- ---------------------------------------------------------------------------
revoke all on function public.withdrawal_reserve(uuid, numeric, text, text, numeric, int) from public, anon, authenticated;
grant execute on function public.withdrawal_reserve(uuid, numeric, text, text, numeric, int) to service_role;
