-- ============================================================================
-- 20 — withdrawal lifecycle
--
--   reserve (available -> locked) -> admin approval -> payout (locked -> out)
--   any failure -> release (locked -> available), exactly once
-- ============================================================================

/* -- reserve --------------------------------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('wd_reserve@test.invalid');
  w public.withdrawals;
begin
  perform tc_test.fund(u, 5000);
  w := tc_test.request_withdrawal(u, 1000, 'WD-KEY-RESERVE-1');

  perform tc_test.eq_text('a request lands in PENDING_ADMIN_APPROVAL', w.status, 'PENDING_ADMIN_APPROVAL');
  perform tc_test.eq_num('reserving moves funds out of available', tc_test.available(u), 4000);
  perform tc_test.eq_num('reserving moves funds into locked', tc_test.locked(u), 1000);
  perform tc_test.eq_num('a hold ledger row is written', tc_test.ledger_count('WHL-' || w.id::text), 1);
  perform tc_test.eq_num('the hold is the only ledger effect', tc_test.available(u) + tc_test.locked(u), 5000);
end $$;

/* -- eligibility rules ----------------------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('wd_rules@test.invalid');
  u_low uuid;
  u_susp uuid;
begin
  perform tc_test.fund(u, 2000);

  perform tc_test.raises('below the currency minimum is refused',
    format($q$select public.withdrawal_reserve(%L::uuid, 50, '+254700000000', 'WD-KEY-MIN', null, 0)$q$, u),
    'WITHDRAWAL_BELOW_MINIMUM');

  /*
    Migration 0017 replaced the currency's flat maximum with the ACCOUNT's own
    ceiling: `withdrawals.default_max` (1,000) for a user holding no package,
    raised by the highest package they hold, and capped by the currency.

    Both bounds are asserted, because both still exist. What changed is which one
    a user meets first: their own figure, not the currency's.
  */
  perform tc_test.raises('above the account maximum is refused',
    format($q$select public.withdrawal_reserve(%L::uuid, 1001, '+254700000000', 'WD-KEY-ACCT-MAX', null, 0)$q$, u),
    'WITHDRAWAL_ABOVE_MAXIMUM');

  perform tc_test.raises('above the currency maximum is refused',
    format($q$select public.withdrawal_reserve(%L::uuid, 100001, '+254700000000', 'WD-KEY-MAX', null, 0)$q$, u),
    'WITHDRAWAL_ABOVE_MAXIMUM');

  -- A LOW balance, and inside the per-request ceiling, so the only rule it can
  -- trip is the wallet balance. (The old version of this assertion funded the
  -- user 2,000 and asked for 5,000 — which the 1,000 ceiling now refuses first,
  -- so it had stopped testing the thing it names.)
  u_low := tc_test.create_user('wd_lowbalance@test.invalid');
  perform tc_test.fund(u_low, 400);
  perform tc_test.raises('more than the available balance is refused',
    format($q$select public.withdrawal_reserve(%L::uuid, 900, '+254700000000', 'WD-KEY-FUNDS', null, 0)$q$, u_low),
    'INSUFFICIENT_AVAILABLE_BALANCE');

  perform tc_test.raises('a non-positive amount is refused',
    format($q$select public.withdrawal_reserve(%L::uuid, 0, '+254700000000', 'WD-KEY-ZERO', null, 0)$q$, u),
    'WITHDRAWAL_AMOUNT_INVALID');

  /*
    The rolling 24-hour limit is now reached from BELOW. It used to be tested with
    a 60,000 request, which no longer gets that far: the per-request ceiling is
    checked first and refuses it. Lowering the daily limit for this one case keeps
    the daily rule itself under test, and pins the order the two are checked in —
    a request that is inside the account ceiling but over the day's remaining
    allowance must still be refused.
  */
  update public.system_settings
     set value = '500'::jsonb
   where key = 'withdrawals.daily_limit';

  perform tc_test.raises('above the rolling daily limit is refused',
    format($q$select public.withdrawal_reserve(%L::uuid, 800, '+254700000000', 'WD-KEY-DAILY', null, 0)$q$, u),
    'WITHDRAWAL_DAILY_LIMIT_EXCEEDED');

  update public.system_settings
     set value = '50000'::jsonb
   where key = 'withdrawals.daily_limit';

  -- a suspended account cannot start a payout
  u_susp := tc_test.create_user('wd_suspended@test.invalid');
  perform tc_test.fund(u_susp, 1000);
  perform tc_test.set_status(u_susp, 'SUSPENDED');
  perform tc_test.raises('a suspended account cannot withdraw',
    format($q$select public.withdrawal_reserve(%L::uuid, 500, '+254700000000', 'WD-KEY-SUSP', null, 0)$q$, u_susp),
    'ACCOUNT_NOT_ACTIVE');
end $$;

/* -- 0017: the ceiling a user meets is their own --------------------------- */

/*
  The rule, in one block: an account holding no package may withdraw up to the
  platform default; a package raises that ceiling to its own; lapsing puts it
  back. The figures here are deliberately small and unrelated to the tiers the
  catalogue ships with, so this test says nothing about the catalogue's pricing.
*/

do $$
declare
  u uuid := tc_test.create_user('wd_ceiling@test.invalid');
  p uuid;
  w public.withdrawals;
begin
  perform tc_test.fund(u, 5000);

  perform tc_test.eq_num('a user holding no package has the platform default ceiling',
    public.user_withdrawal_max(u), 1000);

  perform tc_test.raises('and cannot withdraw above it',
    format($q$select public.withdrawal_reserve(%L::uuid, 1001, '+254700000000', 'WD-KEY-CEIL-BEFORE', null, 0)$q$, u),
    'WITHDRAWAL_ABOVE_MAXIMUM');

  insert into public.packages (name, price, currency, daily_earning_cap, max_withdrawal, status)
  values ('Ceiling test tier', 2000, 'KES', 100, 2500, 'ACTIVE')
  returning id into p;

  insert into public.user_packages (
    user_id, package_id, price_paid, currency, daily_earning_cap, purchase_reference, status
  ) values (u, p, 2000, 'KES', 100, 'UP-CEILING-TEST', 'ACTIVE');

  perform tc_test.eq_num('holding a package raises the ceiling',
    public.user_withdrawal_max(u), 2500);

  w := tc_test.request_withdrawal(u, 2000, 'WD-KEY-CEIL-AFTER');
  perform tc_test.eq_text('and a request above the old ceiling is accepted',
    w.status, 'PENDING_ADMIN_APPROVAL');

  /*
    A package that has run out is not a licence to withdraw more. `purchased_at`
    moves back with the expiry because the table requires the term to end after
    the purchase — a purchase that ended before it began is refused outright.
  */
  update public.user_packages
     set purchased_at = now() - interval '30 days',
         expires_at   = now() - interval '1 day'
   where user_id = u and package_id = p;

  perform tc_test.eq_num('a lapsed package drops the ceiling back to the default',
    public.user_withdrawal_max(u), 1000);

  -- A package can only ever RAISE the ceiling: a cheap tier must not lower it
  -- below what an account with no package at all is allowed.
  update public.user_packages
     set purchased_at = now(),
         expires_at   = null
   where user_id = u and package_id = p;
  update public.packages set max_withdrawal = 500 where id = p;
  perform tc_test.eq_num('a tier below the default does not lower the ceiling',
    public.user_withdrawal_max(u), 1000);
end $$;

/* -- one in flight at a time, and idempotent submission --------------------- */

do $$
declare
  u uuid := tc_test.create_user('wd_pending@test.invalid');
  w1 public.withdrawals;
  w2 public.withdrawals;
begin
  perform tc_test.fund(u, 5000);
  w1 := tc_test.request_withdrawal(u, 500, 'WD-KEY-DUP-A');

  perform tc_test.raises('a second in-flight request is refused',
    format($q$select public.withdrawal_reserve(%L::uuid, 500, '+254700000000', 'WD-KEY-DUP-B', null, 0)$q$, u),
    'PENDING_WITHDRAWAL_EXISTS');

  -- Re-submitting the SAME key is a retry, not a new request.
  w2 := tc_test.request_withdrawal(u, 500, 'WD-KEY-DUP-A');

  perform tc_test.eq_text('replaying the same idempotency key returns the original request', w2.id::text, w1.id::text);
  perform tc_test.eq_num('replaying reserves funds only once', tc_test.locked(u), 500);
  perform tc_test.eq_num('replaying writes only one hold', tc_test.ledger_count('WHL-' || w1.id::text), 1);
end $$;

/* -- approval is mandatory -------------------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('wd_approval@test.invalid');
  admin uuid := tc_test.create_user('wd_admin@test.invalid');
  w public.withdrawals;
begin
  perform tc_test.fund(u, 5000);
  w := tc_test.request_withdrawal(u, 1000, 'WD-KEY-APPROVAL-1');

  perform tc_test.raises('a payout cannot settle before an administrator approves it',
    format($q$select public.withdrawal_complete(%L::uuid, 'PROV-TX-NOAPPROVAL', null, '{}'::jsonb)$q$, w.id),
    'WITHDRAWAL_NOT_APPROVED');

  perform tc_test.eq_num('the refused payout moved no money', tc_test.locked(u), 1000);
end $$;

/* -- payout ---------------------------------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('wd_payout@test.invalid');
  admin uuid := tc_test.create_user('wd_admin2@test.invalid');
  w public.withdrawals;
  done public.withdrawals;
begin
  perform tc_test.fund(u, 5000);
  w := tc_test.request_withdrawal(u, 1000, 'WD-KEY-PAYOUT-1');
  perform tc_test.approve(w.id, admin);

  select * into done from public.withdrawal_complete(w.id, 'PROV-TX-PAYOUT-1', 'PROV-REF-1', '{}'::jsonb);

  perform tc_test.eq_text('the payout settles as COMPLETED', done.status, 'COMPLETED');
  perform tc_test.eq_num('the locked bucket is emptied by the payout', tc_test.locked(u), 0);
  perform tc_test.eq_num('available is untouched by the payout itself', tc_test.available(u), 4000);
  perform tc_test.eq_num('a withdrawal ledger row is written', tc_test.ledger_count('WDR-' || w.id::text), 1);
  perform tc_test.eq_text('the provider transaction id is stored', done.provider_transaction_id, 'PROV-TX-PAYOUT-1');
  perform tc_test.ok('completed_at is stamped', done.completed_at is not null);

  -- Paying twice must be impossible.
  select * into done from public.withdrawal_complete(w.id, 'PROV-TX-PAYOUT-2', null, '{}'::jsonb);
  perform tc_test.eq_num('a second payout writes no second debit', tc_test.ledger_count('WDR-' || w.id::text), 1);
  perform tc_test.eq_num('a second payout cannot drain the wallet again', tc_test.locked(u), 0);
end $$;

/* -- provider transaction ids are single-use -------------------------------- */

do $$
declare
  u_a uuid := tc_test.create_user('wd_provtxt_a@test.invalid');
  u_b uuid := tc_test.create_user('wd_provtxt_b@test.invalid');
  admin uuid := tc_test.create_user('wd_admin3@test.invalid');
  wa public.withdrawals;
  wb public.withdrawals;
begin
  perform tc_test.fund(u_a, 5000);
  perform tc_test.fund(u_b, 5000);
  wa := tc_test.request_withdrawal(u_a, 500, 'WD-KEY-PROVTX-A');
  wb := tc_test.request_withdrawal(u_b, 500, 'WD-KEY-PROVTX-B');
  perform tc_test.approve(wa.id, admin);
  perform tc_test.approve(wb.id, admin);
  perform public.withdrawal_complete(wa.id, 'PROV-TX-SHARED', null, '{}'::jsonb);

  perform tc_test.raises('one provider transaction cannot settle two withdrawals',
    format($q$select public.withdrawal_complete(%L::uuid, 'PROV-TX-SHARED', null, '{}'::jsonb)$q$, wb.id),
    'WITHDRAWAL_PROVIDER_TX_REUSED');
end $$;

/* -- rejection releases the hold, exactly once ------------------------------ */

do $$
declare
  u uuid := tc_test.create_user('wd_reject@test.invalid');
  admin uuid := tc_test.create_user('wd_admin4@test.invalid');
  w public.withdrawals;
  after_release public.withdrawals;
  again public.withdrawals;
begin
  perform tc_test.fund(u, 5000);
  w := tc_test.request_withdrawal(u, 1000, 'WD-KEY-REJECT-1');
  perform tc_test.approve(w.id, admin);

  select * into after_release from public.withdrawal_release(w.id, 'REJECTED', 'Failed review', admin, '{}'::jsonb);

  perform tc_test.eq_text('a rejected request ends up REJECTED', after_release.status, 'REJECTED');
  perform tc_test.eq_num('rejection returns the funds to available', tc_test.available(u), 5000);
  perform tc_test.eq_num('rejection empties the locked bucket', tc_test.locked(u), 0);
  perform tc_test.eq_num('a release ledger row is written', tc_test.ledger_count('WRL-' || w.id::text), 1);
  perform tc_test.eq_text('the hold plus the release nets to zero',
    (select sum(available_delta + locked_delta)::text
       from public.wallet_transactions
      where reference in ('WHL-' || w.id::text, 'WRL-' || w.id::text)), '0.0000');

  -- Releasing again must not credit the user a second time.
  select * into again from public.withdrawal_release(w.id, 'REJECTED', 'again', admin, '{}'::jsonb);
  perform tc_test.eq_num('releasing twice cannot double-credit', tc_test.available(u), 5000);
  perform tc_test.eq_num('releasing twice writes no second release row', tc_test.ledger_count('WRL-' || w.id::text), 1);

  -- Releasing a settled (COMPLETED) withdrawal would manufacture money, so it
  -- must raise. This needs a genuinely completed request: the one above ends
  -- REJECTED, and re-releasing an already-released request is an idle no-op.
  perform tc_test.fund(u, 1000);
  declare
    done public.withdrawals;
    paid public.withdrawals;
  begin
    done := tc_test.request_withdrawal(u, 1000, 'WD-KEY-COMPLETED-1');
    perform tc_test.approve(done.id, admin);
    select * into paid from public.withdrawal_complete(done.id, 'PROV-TX-COMPLETED-1', null, '{}'::jsonb);

    perform tc_test.eq_text('the withdrawal settles as COMPLETED', paid.status, 'COMPLETED');
    perform tc_test.raises('a completed withdrawal cannot be released',
      format($q$select public.withdrawal_release(%L::uuid, 'REJECTED', 'x', null, '{}'::jsonb)$q$, done.id),
      'WITHDRAWAL_ALREADY_COMPLETED');
  end;
end $$;

/* -- provider failure also restores the hold -------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('wd_failed@test.invalid');
  admin uuid := tc_test.create_user('wd_admin5@test.invalid');
  w public.withdrawals;
begin
  perform tc_test.fund(u, 5000);
  -- Under the account's own ceiling (0017); the amount is incidental here — the
  -- assertions below are about the hold coming back, not about the figure.
  w := tc_test.request_withdrawal(u, 900, 'WD-KEY-FAILED-1');
  perform tc_test.approve(w.id, admin);
  perform public.withdrawal_release(w.id, 'FAILED', 'Provider rejected the payout', admin, '{}'::jsonb);

  perform tc_test.eq_num('a failed payout restores the full amount', tc_test.available(u), 5000);
  perform tc_test.eq_num('a failed payout leaves nothing locked', tc_test.locked(u), 0);
end $$;

/* -- fee accounting (regression: the fee must come out of the hold) --------- */

do $$
declare
  u uuid := tc_test.create_user('wd_fee@test.invalid');
  admin uuid := tc_test.create_user('wd_admin6@test.invalid');
  w public.withdrawals;
  done public.withdrawals;
begin
  /*
    This block covers the FLAT fee path, so the percentage is switched off
    deliberately. Migration 0026 gives every currency a 10% withdrawal fee, and
    a percentage takes precedence over the flat column — leaving the percentage
    on would make this block assert 100 instead of 50, and it would stop testing
    the flat accounting it exists for. The percentage path has its own block
    below.
  */
  update public.currencies set withdrawal_fee = 50, withdrawal_fee_percent = 0 where code = 'KES';

  perform tc_test.fund(u, 5000);
  w := tc_test.request_withdrawal(u, 1000, 'WD-KEY-FEE-1');

  perform tc_test.eq_num('the fee is recorded on the request', w.fee, 50);
  perform tc_test.eq_num('the user receives the amount less the fee', w.net_amount, 950);
  perform tc_test.eq_num('the whole gross amount is held', tc_test.locked(u), 1000);

  perform tc_test.approve(w.id, admin);
  select * into done from public.withdrawal_complete(w.id, 'PROV-TX-FEE-1', null, '{}'::jsonb);

  perform tc_test.eq_num('the fee is settled out of the hold, not the available balance', tc_test.locked(u), 0);
  perform tc_test.eq_num('the user is debited exactly the amount requested', tc_test.available(u), 4000);
  perform tc_test.eq_num('a fee ledger row exists', tc_test.ledger_count('WDF-' || w.id::text), 1);

  -- The hold bucket must net to zero: +gross (hold) - net (payout) - fee.
  perform tc_test.eq_text('the hold bucket nets to exactly zero',
    (select sum(locked_delta)::text
       from public.wallet_transactions
      where reference in ('WHL-' || w.id::text, 'WDR-' || w.id::text, 'WDF-' || w.id::text)), '0.0000');

  -- ...and the whole gross amount must leave the wallet for good: the user
  -- paid the payout and the fee, and neither is still held anywhere.
  perform tc_test.eq_text('available falls by exactly the gross amount',
    (select sum(available_delta)::text
       from public.wallet_transactions
      where reference in ('WHL-' || w.id::text, 'WDR-' || w.id::text, 'WDF-' || w.id::text)), '-1000.0000');

  -- The paid amount must leave the wallet permanently: total falls by 1000.
  perform tc_test.eq_num('total wallet value fell by exactly the requested amount',
    tc_test.available(u) + tc_test.locked(u), 4000);

  -- Restore the shipped configuration exactly: no flat fee, and the 10%
  -- percentage from 0026. Leaving the percentage at 0 would leak into every
  -- later test in the run.
  update public.currencies set withdrawal_fee = 0, withdrawal_fee_percent = 10 where code = 'KES';
end $$;

/* -- percentage fee (migration 0026) -------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('wd_fee_pct@test.invalid');
  admin uuid := tc_test.create_user('wd_admin_pct@test.invalid');
  u_round uuid := tc_test.create_user('wd_fee_round@test.invalid');
  u_override uuid := tc_test.create_user('wd_fee_override@test.invalid');
  u_guard uuid := tc_test.create_user('wd_fee_guard@test.invalid');
  w public.withdrawals;
  w_pct public.withdrawals;
  configured numeric;
begin
  select withdrawal_fee_percent into configured from public.currencies where code = 'KES';
  perform tc_test.eq_num('KES charges a 10% withdrawal fee', configured, 10);

  perform tc_test.fund(u, 5000);
  w_pct := tc_test.request_withdrawal(u, 1000, 'WD-KEY-PCT-1');

  perform tc_test.eq_num('the fee is 10% of the amount requested', w_pct.fee, 100);
  perform tc_test.eq_num('the user receives the amount less the fee', w_pct.net_amount, 900);
  /*
    The hold stays at the GROSS, not the net. The whole request leaves the
    available balance, and the payout and the fee are both settled out of the
    hold — so a user cannot spend the fee while their request is in review.
  */
  perform tc_test.eq_num('the whole gross amount is held', tc_test.locked(u), 1000);
  perform tc_test.eq_num('the available balance falls by the gross', tc_test.available(u), 4000);

  /* Rounding is part of the rule: 10% of 333 is 33.30, not 33.3333. */
  perform tc_test.fund(u_round, 5000);
  w := tc_test.request_withdrawal(u_round, 333, 'WD-KEY-PCT-ROUND');
  perform tc_test.eq_num('the fee is rounded to the cent', w.fee, 33.3);
  perform tc_test.eq_num('the payout is the rounded remainder', w.net_amount, 299.7);

  /*
    An explicit fee still wins over the configured percentage. The application
    always passes null today, but the parameter is part of the function's own
    contract and a percentage must not make it inert.
  */
  perform tc_test.fund(u_override, 5000);
  select * into w from public.withdrawal_reserve(u_override, 500, '+254700000000', 'WD-KEY-PCT-OVERRIDE', 7, 0);
  perform tc_test.eq_num('an explicit fee overrides the percentage', w.fee, 7);
  perform tc_test.eq_num('the payout follows the explicit fee', w.net_amount, 493);

  /*
    A fee that would consume the whole request is refused rather than paying out
    nothing. Forced here by temporarily setting 100%, which no shipped
    configuration uses.
  */
  perform tc_test.fund(u_guard, 5000);
  update public.currencies set withdrawal_fee_percent = 100 where code = 'KES';
  perform tc_test.raises('a fee equal to the request is refused',
    format($q$select public.withdrawal_reserve(%L::uuid, 500, '+254700000000', 'WD-KEY-PCT-GUARD', null, 0)$q$, u_guard),
    'WITHDRAWAL_FEE_INVALID');
  update public.currencies set withdrawal_fee_percent = 10 where code = 'KES';

  /*
    Conservation on the percentage path: the hold bucket must net to zero
    (+gross held, -net paid, -fee kept) and the whole gross must leave the
    wallet permanently.
  */
  perform tc_test.approve(w_pct.id, admin);
  select * into w_pct from public.withdrawal_complete(w_pct.id, 'PROV-TX-PCT-1', null, '{}'::jsonb);

  perform tc_test.eq_num('the fee is settled out of the hold, not the available balance', tc_test.locked(u), 0);
  perform tc_test.eq_num('the user is debited exactly the amount requested', tc_test.available(u), 4000);
  perform tc_test.eq_num('a fee ledger row exists', tc_test.ledger_count('WDF-' || w_pct.id::text), 1);

  perform tc_test.eq_text('the hold bucket nets to exactly zero',
    (select sum(locked_delta)::text
       from public.wallet_transactions
      where reference in ('WHL-' || w_pct.id::text, 'WDR-' || w_pct.id::text, 'WDF-' || w_pct.id::text)), '0.0000');

  perform tc_test.eq_text('available falls by exactly the gross amount',
    (select sum(available_delta)::text
       from public.wallet_transactions
      where reference in ('WHL-' || w_pct.id::text, 'WDR-' || w_pct.id::text, 'WDF-' || w_pct.id::text)), '-1000.0000');

  perform tc_test.eq_num('total wallet value fell by exactly the requested amount',
    tc_test.available(u) + tc_test.locked(u), 4000);
end $$;
