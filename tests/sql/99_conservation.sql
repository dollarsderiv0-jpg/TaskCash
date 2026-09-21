-- ============================================================================
-- 99 — global invariants
--
-- These run last and check the whole database, not one flow. They are the
-- assertions that would catch a bug nobody thought to write a unit test for.
-- ============================================================================

-- 1. Balances must equal the sum of every ledger effect, for every wallet.
do $$
declare
  broken int;
  sample text;
begin
  select count(*)::int into broken
    from (
      select w.id
        from public.wallets w
        left join public.wallet_transactions t on t.wallet_id = w.id
       group by w.id, w.available_balance, w.locked_balance
      having w.available_balance + w.locked_balance
             <> coalesce(sum(t.available_delta + t.locked_delta), 0)
    ) x;

  select format('wallet %s holds %s but its ledger sums to %s',
                w.id, w.available_balance + w.locked_balance,
                coalesce(sum(t.available_delta + t.locked_delta), 0))
    into sample
    from public.wallets w
    left join public.wallet_transactions t on t.wallet_id = w.id
   group by w.id, w.available_balance, w.locked_balance
  having w.available_balance + w.locked_balance
         <> coalesce(sum(t.available_delta + t.locked_delta), 0)
   limit 1;

  perform tc_test.eq_num('every wallet balance equals the sum of its ledger entries', broken, 0);
  if broken > 0 then
    perform tc_test.ok('wallet/ledger mismatch example', false, sample);
  end if;
end $$;

-- 2. No balance may be negative, anywhere.
do $$
declare
  negative int;
begin
  select count(*)::int into negative
    from public.wallets where available_balance < 0 or locked_balance < 0;

  perform tc_test.eq_num('no wallet has a negative balance', negative, 0);
end $$;

-- 3. Every settled withdrawal must have moved exactly its amount out.
--
-- Two separate things are true of a settled payout, and both are asserted:
--   * the hold bucket nets to zero — +gross held, then -net paid and -fee kept;
--   * the available bucket fell by exactly the gross amount, so nothing was
--     paid twice, nothing was charged twice, and no part of the hold is
--     stranded in `locked` forever.
do $$
declare
  broken_hold int;
  broken_total int;
begin
  select count(*)::int into broken_hold
    from (
      select w.id
        from public.withdrawals w
        join public.wallet_transactions t
          on t.reference in ('WHL-' || w.id::text, 'WDR-' || w.id::text, 'WDF-' || w.id::text)
       where w.status = 'COMPLETED'
       group by w.id
      having sum(t.locked_delta) <> 0
    ) x;

  select count(*)::int into broken_total
    from (
      select w.id
        from public.withdrawals w
        join public.wallet_transactions t
          on t.reference in ('WHL-' || w.id::text, 'WDR-' || w.id::text, 'WDF-' || w.id::text)
       where w.status = 'COMPLETED'
       group by w.id, w.amount
      having sum(t.available_delta) <> -w.amount
    ) x;

  perform tc_test.eq_num('every completed withdrawal consumes its hold exactly', broken_hold, 0);
  perform tc_test.eq_num('every completed withdrawal removes exactly its amount', broken_total, 0);
end $$;

-- 4. Every closed-without-payout withdrawal must have released its hold.
do $$
declare
  broken int;
begin
  select count(*)::int into broken
    from (
      select w.id
        from public.withdrawals w
        join public.wallet_transactions t
          on t.reference in ('WHL-' || w.id::text, 'WRL-' || w.id::text)
       where w.status in ('REJECTED', 'FAILED', 'CANCELLED')
       group by w.id
      having sum(t.available_delta + t.locked_delta) <> 0
    ) x;

  perform tc_test.eq_num('every rejected or failed withdrawal releases its hold', broken, 0);
end $$;

-- 5. No withdrawal may be left holding funds without being open.
do $$
declare
  stranded int;
begin
  select count(*)::int into stranded
    from public.withdrawals w
   where w.status in ('COMPLETED', 'REJECTED', 'FAILED', 'CANCELLED')
     and exists (
       select 1 from public.wallet_transactions t
        where t.reference = 'WHL-' || w.id::text
     )
     and not exists (
       select 1 from public.wallet_transactions t
        where t.reference in ('WDR-' || w.id::text, 'WRL-' || w.id::text)
     );

  perform tc_test.eq_num('no withdrawal has left funds stranded in the locked bucket', stranded, 0);
end $$;

-- 6. Every rewarded watch session has exactly one reward row, and its amount
--    matches the transaction.
do $$
declare
  broken int;
begin
  select count(*)::int into broken
    from (
      select s.id
        from public.video_watch_sessions s
        left join public.wallet_transactions t on t.id = s.reward_transaction_id
       where s.status = 'REWARDED'
       group by s.id, s.reward_transaction_id, s.reward_amount
      having count(t.id) <> 1
          or coalesce(sum(t.amount), 0) <> coalesce(s.reward_amount, 0)
    ) x;

  perform tc_test.eq_num('every rewarded session has exactly one matching reward row', broken, 0);
end $$;

do $$
declare
  orphans int;
begin
  select count(*)::int into orphans
    from public.video_watch_sessions s
   where s.status = 'REWARDED'
     and (s.reward_transaction_id is null or s.rewarded_at is null);

  perform tc_test.eq_num('no session is marked rewarded without a ledger row', orphans, 0);
end $$;

-- 7. Every completed deposit is credited exactly once, for its own amount.
do $$
declare
  broken int;
begin
  select count(*)::int into broken
    from (
      select d.id
        from public.deposits d
        left join public.wallet_transactions t on t.id = d.wallet_transaction_id
       where d.status = 'COMPLETED'
       group by d.id, d.wallet_transaction_id, d.amount, d.currency
      having count(t.id) <> 1
          or coalesce(sum(t.amount), 0) <> d.amount
          or coalesce(max(t.type), '') <> 'DEPOSIT'
    ) x;

  perform tc_test.eq_num('every completed deposit is credited exactly once for its own amount', broken, 0);
end $$;

-- 8. Every credited referral commission points at a real ledger row of the
--    same value.
do $$
declare
  broken int;
begin
  select count(*)::int into broken
    from public.referral_commissions c
    left join public.wallet_transactions t on t.id = c.wallet_transaction_id
   where c.status = 'CREDITED'
     and (t.id is null or t.amount <> c.amount or t.type <> 'REFERRAL_REWARD');

  perform tc_test.eq_num('every credited commission matches a ledger row of the same amount', broken, 0);
end $$;

-- 9. A settled ledger row must have moved something. A COMPLETED row with zero
--    effect would mean money was marked as moved without being moved.
do $$
declare
  inert int;
begin
  select count(*)::int into inert
    from public.wallet_transactions
   where status in ('COMPLETED', 'PROCESSING')
     and available_delta = 0
     and locked_delta = 0;

  perform tc_test.eq_num('no settled ledger row has a zero effect', inert, 0);
end $$;

-- 10. Campaigns can never spend past their budget.
do $$
declare
  overspent int;
begin
  select count(*)::int into overspent from public.video_campaigns where spent > budget;
  perform tc_test.eq_num('no campaign has spent past its budget', overspent, 0);
end $$;

-- 11. PENDING ledger rows must be genuinely inert.
do $$
declare
  active_pending int;
begin
  select count(*)::int into active_pending
    from public.wallet_transactions
   where status = 'PENDING'
     and (available_delta <> 0 or locked_delta <> 0);

  perform tc_test.eq_num('pending ledger rows never affect a balance', active_pending, 0);
end $$;
