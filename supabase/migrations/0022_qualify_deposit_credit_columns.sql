-- ============================================================================
-- 0022 — Qualify the column references in deposit_credit
--
-- THE FAILURE
-- -----------
-- `deposit_credit` returns a table whose first column is named `id`:
--
--   returns table (
--     id                    uuid,
--     user_id               uuid,
--     ...
--
-- In PL/pgSQL every OUT parameter of a `returns table` function is also a
-- variable in scope for the whole body. The body then writes an unqualified
-- `id` in two places, where it means the `deposits` row:
--
--   select 1 from public.deposits
--    where provider_transaction_id = p_provider_transaction_id
--      and id <> v_dep.id                       -- ← OUT parameter, or column?
--
--   update public.deposits
--      set ...
--    where id = v_dep.id                        -- ← same ambiguity
--
-- PostgreSQL refuses to guess between a variable and a column:
--
--   42702  column reference "id" is ambiguous
--          It could refer to either a PL/pgSQL variable or a table column.
--
-- WHERE IT BITES
-- --------------
-- On the SUCCESS path only — after the deposit is found, the amount has been
-- verified, and the wallet credit is about to be posted. So every earlier check
-- passes and the credit itself is what fails:
--
--   · DEPOSIT_NOT_FOUND        — fires before, unchanged
--   · DEPOSIT_AMOUNT_MISMATCH  — fires before, unchanged
--   · 42702                    — here, on every deposit that would have worked
--
-- In other words the error is invisible to any test that only exercises the
-- refusals, which is exactly the shape of the tests around this function. It is
-- also invisible until a deposit is genuinely ready to be credited: with the
-- ambiguous overload from 0002 still present (dropped in 0021), the call could
-- not even reach the body, so the two faults masked each other.
--
-- THE FIX
-- -------
-- Alias the table and qualify the column, in all three statements that touch
-- `deposits`. Nothing else changes: the same lookups, the same order, the same
-- idempotent re-credit path, the same bonus and referral calls, and the same
-- notification. `p_source => 'MPESA'` is reproduced as-is — it is a separate
-- question (the ledger's source for a deposit does not follow the actual
-- provider) and changing it is not this migration's business.
-- ============================================================================

create or replace function public.deposit_credit(
  p_merchant_reference      text,
  p_provider_transaction_id text default null,
  p_provider_reference      text default null,
  p_amount                  numeric default null,
  p_payload                 jsonb default null
)
returns table (
  id                    uuid,
  user_id               uuid,
  amount                numeric,
  currency              text,
  credited              boolean,
  wallet_transaction_id uuid,
  bonus_amount          numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dep   public.deposits;
  v_tx    public.wallet_transactions;
  v_bonus numeric := 0;
begin
  select d.* into v_dep from public.deposits d
   where d.merchant_reference = p_merchant_reference
     and d.status in ('PENDING', 'PROCESSING')
   for update;

  if not found then
    -- Check if already completed — idempotent.
    select d.* into v_dep from public.deposits d
     where d.merchant_reference = p_merchant_reference
       and d.status = 'COMPLETED';
    if found then
      return query select v_dep.id, v_dep.user_id, v_dep.amount, v_dep.currency,
                         false, v_dep.wallet_transaction_id, 0::numeric;
      return;
    end if;
    raise exception 'DEPOSIT_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- Optional amount verification.
  if p_amount is not null and p_amount <> v_dep.amount then
    raise exception 'DEPOSIT_AMOUNT_MISMATCH' using errcode = 'P0001';
  end if;

  -- Provider TX deduplication.
  if p_provider_transaction_id is not null then
    if exists (
      select 1 from public.deposits d
       where d.provider_transaction_id = p_provider_transaction_id
         and d.id <> v_dep.id
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
    p_source             => 'MPESA'
  );

  update public.deposits d
     set status = 'COMPLETED',
         provider_transaction_id = coalesce(p_provider_transaction_id, d.provider_transaction_id),
         provider_reference = coalesce(p_provider_reference, p_merchant_reference),
         callback_payload = coalesce(p_payload, d.callback_payload),
         verified_at = now(),
         completed_at = now(),
         wallet_transaction_id = v_tx.id,
         failure_reason = null
   where d.id = v_dep.id;

  -- Apply deposit bonus
  v_bonus := public.apply_deposit_bonus(v_dep.user_id, v_dep.amount, v_dep.currency, v_dep.id);

  -- Referral commission on deposit
  perform public.referral_commission_on_deposit(v_dep.user_id, v_tx.id, v_dep.amount, v_dep.currency);

  perform public.notify_user(
    v_dep.user_id, 'DEPOSIT_COMPLETED',
    'Deposit confirmed',
    'Your deposit of ' || v_dep.currency || ' ' || to_char(v_dep.amount, 'FM999,999,990.00') ||
      ' has been confirmed and credited to your wallet.' ||
      case when v_bonus > 0 then ' Plus a bonus of KES ' || to_char(v_bonus, 'FM999,999,990.00') || '!' else '' end,
    'SUCCESS', '/dashboard/wallet'
  );

  return query select v_dep.id, v_dep.user_id, v_dep.amount, v_dep.currency,
                     true, v_tx.id, v_bonus;
end;
$$;


-- ============================================================================
-- Verification. The ambiguity is a runtime fault, so it cannot be caught by
-- compiling the function — it is caught by making it run. This rolls a real
-- deposit through the function inside a subtransaction that is then rolled
-- back, so the check proves the success path executes while leaving no row
-- behind.
-- ============================================================================

do $$
declare
  v_user    uuid;
  v_wallet  uuid;
  v_ref     text := 'VERIFY-0022-' || gen_random_uuid()::text;
  v_result  record;
begin
  select p.id, w.id into v_user, v_wallet
    from public.profiles p
    join public.wallets w on w.user_id = p.id
   where w.status = 'ACTIVE'
   limit 1;

  if v_user is null then
    raise notice 'no active profile to verify against — skipping the runtime check';
    return;
  end if;

  begin
    insert into public.deposits (
      user_id, wallet_id, amount, currency, phone, provider,
      merchant_reference, status, idempotency_key
    ) values (
      v_user, v_wallet, 1, 'KES', '254700000000', 'PAYHERO',
      v_ref, 'PENDING', v_ref
    );

    select * into v_result from public.deposit_credit(
      p_merchant_reference      => v_ref,
      p_provider_transaction_id => v_ref,
      p_provider_reference      => v_ref,
      p_amount                  => 1,
      p_payload                 => jsonb_build_object('verification', '0022')
    );

    if v_result.credited is not true then
      raise exception 'deposit_credit ran but did not credit (credited=%)', v_result.credited;
    end if;

    raise notice 'deposit_credit success path verified — credited=%', v_result.credited;

    -- Undo the whole probe: the deposit, the ledger row it posted, the wallet
    -- movement and any bonus. Nothing from this check may survive.
    raise exception 'ROLLBACK_VERIFICATION';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_VERIFICATION' then
        raise;
      end if;
  end;
end $$;
