-- ============================================================================
-- TaskCash Pro — 0002 Ledger, deposits, withdrawals, settings, safety
--
-- Every balance change in this system goes through public.wallet_post().
-- That function is the single choke point that (a) locks the wallet row,
-- (b) refuses to go negative, (c) writes an immutable ledger row, and
-- (d) is idempotent per `reference`. The higher-level operations below wrap
-- it so a single Postgres transaction performs the whole financial event.
--
-- All functions in this file are SECURITY DEFINER and executable only by the
-- service role. Nothing here is callable from a browser.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- settings helpers
-- ---------------------------------------------------------------------------
create or replace function public.setting_json(p_key text, p_default jsonb default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from public.system_settings where key = p_key), p_default);
$$;

create or replace function public.setting_num(p_key text, p_default numeric)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select (value #>> '{}')::numeric from public.system_settings
      where key = p_key and value is not null and jsonb_typeof(value) in ('number','string')),
    p_default
  );
$$;

create or replace function public.setting_bool(p_key text, p_default boolean)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select (value #>> '{}')::boolean from public.system_settings
      where key = p_key and value is not null and jsonb_typeof(value) in ('boolean','string')),
    p_default
  );
$$;

create or replace function public.setting_text(p_key text, p_default text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select value #>> '{}' from public.system_settings
      where key = p_key and value is not null),
    p_default
  );
$$;

-- ---------------------------------------------------------------------------
-- THE ledger primitive
-- ---------------------------------------------------------------------------
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
    if p_type in ('WITHDRAWAL_HOLD', 'WITHDRAWAL', 'WITHDRAWAL_FEE')
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

-- ---------------------------------------------------------------------------
-- notifications helper
-- ---------------------------------------------------------------------------
create or replace function public.notify_user(
  p_user_id uuid,
  p_type    text,
  p_title   text,
  p_message text,
  p_severity text default 'INFO',
  p_link    text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.notifications (user_id, type, title, message, severity, link, metadata)
  values (p_user_id, p_type, p_title, p_message, p_severity, p_link, coalesce(p_metadata, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- audit helper
-- ---------------------------------------------------------------------------
create or replace function public.write_audit(
  p_admin_id  uuid,
  p_user_id   uuid,
  p_action    text,
  p_entity    text,
  p_entity_id text,
  p_description text,
  p_metadata  jsonb default '{}'::jsonb,
  p_ip_hash   text default null,
  p_user_agent text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.audit_logs (admin_id, user_id, action, entity_type, entity_id, description, metadata, ip_hash, user_agent)
  values (p_admin_id, p_user_id, p_action, p_entity, p_entity_id, p_description, coalesce(p_metadata, '{}'::jsonb), p_ip_hash, p_user_agent);
$$;

-- ---------------------------------------------------------------------------
-- fraud helpers
-- ---------------------------------------------------------------------------
create or replace function public.record_fraud_event(
  p_user_id  uuid,
  p_type     text,
  p_severity text,
  p_score    int,
  p_details  jsonb default '{}'::jsonb
)
returns public.fraud_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.fraud_events;
begin
  insert into public.fraud_events (user_id, event_type, severity, score, details, status)
  values (p_user_id, p_type, p_severity, greatest(0, least(100, coalesce(p_score, 0))), coalesce(p_details, '{}'::jsonb), 'OPEN')
  returning * into v_row;

  -- Risk score is a rolling signal, not an automatic ban.
  update public.profiles
     set risk_score = least(100, risk_score + greatest(0, coalesce(p_score, 0)))
   where id = p_user_id;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- rate limiting (works on stateless/serverless deployments)
-- ---------------------------------------------------------------------------
create or replace function public.rate_limit_hit(
  p_bucket         text,
  p_identifier     text,
  p_limit          int,
  p_window_seconds int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_hits   int;
begin
  if p_limit <= 0 or p_window_seconds <= 0 then
    return true;
  end if;

  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limits (bucket, identifier, window_start, hits)
  values (p_bucket, p_identifier, v_window, 1)
  on conflict (bucket, identifier, window_start)
    do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;

  return v_hits <= p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- idempotency claim for API-level operations
-- ---------------------------------------------------------------------------
create or replace function public.claim_idempotency_key(
  p_key   text,
  p_user  uuid,
  p_scope text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.idempotency_keys (key, user_id, scope)
  values (p_key, p_user, p_scope);
  return true;
exception
  when unique_violation then
    return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- deposit lifecycle
-- ---------------------------------------------------------------------------
create or replace function public.deposit_credit(
  p_merchant_reference      text,
  p_provider_transaction_id text default null,
  p_payload                 jsonb default '{}'::jsonb
)
returns table (
  deposit_id  uuid,
  user_id     uuid,
  amount      numeric,
  currency    text,
  credited    boolean,
  duplicate   boolean,
  tx_id       uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dep public.deposits;
  v_tx  public.wallet_transactions;
begin
  perform pg_advisory_xact_lock(hashtext('deposit:' || p_merchant_reference));

  select * into v_dep from public.deposits where merchant_reference = p_merchant_reference for update;
  if not found then
    raise exception 'DEPOSIT_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Already settled -> acknowledge without moving money again.
  if v_dep.status = 'COMPLETED' and v_dep.wallet_transaction_id is not null then
    return query select v_dep.id, v_dep.user_id, v_dep.amount, v_dep.currency, false, true, v_dep.wallet_transaction_id;
    return;
  end if;
  if v_dep.status in ('REJECTED','CANCELLED','FAILED','REVERSED') then
    raise exception 'DEPOSIT_NOT_PAYABLE' using errcode = 'P0001';
  end if;

  -- A provider transaction id may only ever settle one deposit.
  if p_provider_transaction_id is not null then
    if exists (
      select 1 from public.deposits
       where provider_transaction_id = p_provider_transaction_id
         and id <> v_dep.id
    ) then
      raise exception 'DEPOSIT_PROVIDER_TX_REUSED' using errcode = 'P0001';
    end if;
  end if;

  v_tx := public.wallet_post(
    p_user_id            => v_dep.user_id,
    p_type               => 'DEPOSIT',
    p_amount             => v_dep.amount,
    p_status             => 'COMPLETED',
    p_reference          => 'DEP-' || v_dep.id::text,
    p_external_reference => coalesce(p_provider_transaction_id, p_merchant_reference),
    p_description        => 'Deposit via ' || v_dep.provider,
    p_metadata           => jsonb_build_object(
                              'merchant_reference', p_merchant_reference,
                              'phone', v_dep.phone,
                              'provider', v_dep.provider
                            ),
    p_source             => 'SASAPAY'
  );

  update public.deposits
     set status = 'COMPLETED',
         provider_transaction_id = coalesce(p_provider_transaction_id, provider_transaction_id),
         provider_reference = coalesce(provider_reference, p_merchant_reference),
         callback_payload = coalesce(p_payload, callback_payload),
         verified_at = now(),
         completed_at = now(),
         wallet_transaction_id = v_tx.id,
         failure_reason = null
   where id = v_dep.id;

  perform public.notify_user(
    v_dep.user_id, 'DEPOSIT_COMPLETED', 'Deposit confirmed',
    'Your deposit of ' || v_dep.currency || ' ' || to_char(v_dep.amount, 'FM999,999,990.00') ||
      ' has been confirmed and credited to your wallet.',
    'SUCCESS', '/dashboard/wallet'
  );

  return query select v_dep.id, v_dep.user_id, v_dep.amount, v_dep.currency, true, false, v_tx.id;
end;
$$;

create or replace function public.deposit_fail(
  p_merchant_reference text,
  p_reason             text,
  p_status             text default 'FAILED',
  p_payload            jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dep public.deposits;
begin
  select * into v_dep from public.deposits where merchant_reference = p_merchant_reference for update;
  if not found then
    return;
  end if;
  if v_dep.status = 'COMPLETED' then
    return; -- never downgrade a settled deposit
  end if;

  update public.deposits
     set status = case when p_status in ('FAILED','REJECTED','CANCELLED') then p_status else 'FAILED' end,
         failure_reason = left(coalesce(p_reason, 'Payment was not completed'), 500),
         callback_payload = coalesce(p_payload, callback_payload),
         completed_at = now()
   where id = v_dep.id;

  perform public.notify_user(
    v_dep.user_id, 'DEPOSIT_FAILED', 'Deposit not completed',
    'Your deposit of ' || v_dep.currency || ' ' || to_char(v_dep.amount, 'FM999,999,990.00') ||
      ' was not completed. No funds were added to your wallet.',
    'WARNING', '/dashboard/deposit'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- withdrawal lifecycle
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
  if p_amount > v_currency.max_withdrawal then
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

  -- Rolling 24h volume limit.
  select coalesce(sum(amount), 0) into v_daily
    from public.withdrawals
   where user_id = p_user_id
     and status not in ('REJECTED','FAILED','CANCELLED')
     and requested_at > now() - interval '24 hours';
  if v_daily + p_amount > public.setting_num('withdrawals.daily_limit', v_currency.max_withdrawal) then
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

create or replace function public.withdrawal_release(
  p_withdrawal_id uuid,
  p_status        text,
  p_reason        text default null,
  p_admin_id      uuid default null,
  p_metadata      jsonb default '{}'::jsonb
)
returns public.withdrawals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_w public.withdrawals;
begin
  perform pg_advisory_xact_lock(hashtext('withdrawal:' || p_withdrawal_id::text));

  select * into v_w from public.withdrawals where id = p_withdrawal_id for update;
  if not found then
    raise exception 'WITHDRAWAL_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_w.status = 'COMPLETED' then
    raise exception 'WITHDRAWAL_ALREADY_COMPLETED' using errcode = 'P0001';
  end if;
  if v_w.status in ('REJECTED','FAILED','CANCELLED') then
    return v_w; -- already released
  end if;
  if p_status not in ('REJECTED','FAILED','CANCELLED') then
    raise exception 'WITHDRAWAL_RELEASE_STATUS_INVALID' using errcode = '22023';
  end if;

  -- Return the held funds to the available bucket, exactly once.
  perform public.wallet_post(
    p_user_id     => v_w.user_id,
    p_type        => 'WITHDRAWAL_RELEASE',
    p_amount      => v_w.amount,
    p_status      => 'COMPLETED',
    p_reference   => 'WRL-' || v_w.id::text,
    p_description => 'Withdrawal hold released: ' || coalesce(p_reason, p_status),
    p_metadata    => jsonb_build_object('withdrawal_id', v_w.id, 'release_status', p_status) || coalesce(p_metadata, '{}'::jsonb),
    p_source      => 'WALLET',
    p_created_by  => p_admin_id
  );

  update public.withdrawals
     set status = p_status,
         failure_reason = left(coalesce(p_reason, failure_reason), 500),
         admin_id = coalesce(p_admin_id, admin_id),
         admin_rejected_at = case when p_status = 'REJECTED' then now() else admin_rejected_at end,
         rejection_reason = case when p_status = 'REJECTED' then left(coalesce(p_reason, rejection_reason), 500) else rejection_reason end
   where id = v_w.id
   returning * into v_w;

  perform public.notify_user(
    v_w.user_id,
    case when p_status = 'REJECTED' then 'WITHDRAWAL_REJECTED' else 'WITHDRAWAL_FAILED' end,
    case when p_status = 'REJECTED' then 'Withdrawal request not approved' else 'Withdrawal could not be completed' end,
    'Your withdrawal request of ' || v_w.currency || ' ' || to_char(v_w.amount, 'FM999,999,990.00') ||
      ' was not paid out and the funds have been returned to your available balance.' ||
      case when p_reason is not null then ' Reason: ' || p_reason else '' end,
    'WARNING', '/dashboard/withdraw'
  );

  return v_w;
end;
$$;

create or replace function public.withdrawal_complete(
  p_withdrawal_id           uuid,
  p_provider_transaction_id text,
  p_provider_reference      text default null,
  p_response                jsonb default '{}'::jsonb
)
returns public.withdrawals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_w public.withdrawals;
  v_net numeric(20,4);
begin
  perform pg_advisory_xact_lock(hashtext('withdrawal:' || p_withdrawal_id::text));

  select * into v_w from public.withdrawals where id = p_withdrawal_id for update;
  if not found then
    raise exception 'WITHDRAWAL_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_w.status = 'COMPLETED' then
    return v_w; -- idempotent: never pay twice
  end if;
  if v_w.status in ('REJECTED','FAILED','CANCELLED') then
    raise exception 'WITHDRAWAL_NOT_PAYABLE' using errcode = 'P0001';
  end if;

  -- Defence in depth for the platform's hardest rule: no withdrawal is ever
  -- paid automatically. A payout can only settle a request that an
  -- administrator explicitly approved, whatever the caller believes.
  if v_w.admin_approved_at is null then
    raise exception 'WITHDRAWAL_NOT_APPROVED' using errcode = 'P0001';
  end if;

  if p_provider_transaction_id is not null and exists (
    select 1 from public.withdrawals
     where provider_transaction_id = p_provider_transaction_id and id <> v_w.id
  ) then
    raise exception 'WITHDRAWAL_PROVIDER_TX_REUSED' using errcode = 'P0001';
  end if;

  v_net := v_w.amount - v_w.fee;

  -- Settle the locked bucket: net payout + separately visible fee.
  perform public.wallet_post(
    p_user_id     => v_w.user_id,
    p_type        => 'WITHDRAWAL',
    p_amount      => v_net,
    p_status      => 'COMPLETED',
    p_reference   => 'WDR-' || v_w.id::text,
    p_external_reference => p_provider_transaction_id,
    p_description => 'Withdrawal paid out to ' || v_w.phone,
    p_metadata    => jsonb_build_object('withdrawal_id', v_w.id, 'net_amount', v_net, 'phone', v_w.phone),
    p_source      => 'SASAPAY'
  );

  -- Platform revenue for this payout. Posted from the hold, so the locked
  -- bucket nets to zero: +amount (hold) - net (WITHDRAWAL) - fee (this entry).
  if v_w.fee > 0 then
    perform public.wallet_post(
      p_user_id     => v_w.user_id,
      p_type        => 'WITHDRAWAL_FEE',
      p_amount      => v_w.fee,
      p_status      => 'COMPLETED',
      p_reference   => 'WDF-' || v_w.id::text,
      p_description => 'Withdrawal fee',
      p_metadata    => jsonb_build_object('withdrawal_id', v_w.id),
      p_source      => 'SASAPAY'
    );
  end if;

  update public.withdrawals
     set status = 'COMPLETED',
         provider_transaction_id = coalesce(p_provider_transaction_id, provider_transaction_id),
         provider_reference = coalesce(p_provider_reference, provider_reference),
         provider_response = coalesce(p_response, provider_response),
         net_amount = v_net,
         failure_reason = null,
         completed_at = now()
   where id = v_w.id
   returning * into v_w;

  perform public.notify_user(
    v_w.user_id, 'WITHDRAWAL_COMPLETED', 'Withdrawal paid',
    'Your withdrawal of ' || v_w.currency || ' ' || to_char(v_net, 'FM999,999,990.00') ||
      ' has been sent to ' || v_w.phone || '.',
    'SUCCESS', '/dashboard/withdraw'
  );

  return v_w;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin wallet adjustment (always audited)
-- ---------------------------------------------------------------------------
create or replace function public.admin_adjust_wallet(
  p_admin_id  uuid,
  p_user_id   uuid,
  p_amount    numeric,
  p_reason    text
)
returns public.wallet_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tx public.wallet_transactions;
begin
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'ADJUSTMENT_REASON_REQUIRED' using errcode = '22023';
  end if;

  v_tx := public.wallet_post(
    p_user_id     => p_user_id,
    p_type        => 'ADMIN_ADJUSTMENT',
    p_amount      => p_amount,
    p_status      => 'COMPLETED',
    p_reference   => 'ADJ-' || gen_random_uuid()::text,
    p_description => p_reason,
    p_metadata    => jsonb_build_object('reason', p_reason, 'admin_id', p_admin_id),
    p_source      => 'ADMIN',
    p_created_by  => p_admin_id
  );

  perform public.write_audit(
    p_admin_id, p_user_id, 'WALLET_ADJUSTMENT', 'wallet_transaction', v_tx.id::text,
    'Adjusted wallet by ' || p_amount::text || ' — ' || p_reason,
    jsonb_build_object('amount', p_amount, 'reason', p_reason)
  );

  return v_tx;
end;
$$;
