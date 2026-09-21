-- ============================================================================
-- 10 — the ledger primitive (public.wallet_post) and user provisioning
-- ============================================================================

/* -- provisioning (registration path) ------------------------------------- */

select tc_test.ok('provisioning creates a profile id', tc_test.create_user('ledger1@test.invalid') is not null);

-- Column names deliberately do not collide with the PL/pgSQL variable names
-- below: a variable and a column of the same name would shadow, and
-- `u3 := (select u3 from t_ledger)` would silently read NULL.
create temp table t_ledger as
select tc_test.create_user('ledger2@test.invalid') as user2,
       tc_test.create_user('ledger3@test.invalid') as user3;

do $$
declare
  u1 uuid := (select id from public.profiles where email = 'ledger1@test.invalid');
  p  public.profiles;
  w  public.wallets;
begin
  select * into p from public.profiles where id = u1;
  select * into w from public.wallets where user_id = u1;

  perform tc_test.eq_text('provisioned profile is ACTIVE', p.status, 'ACTIVE');
  perform tc_test.ok('provisioned referral code matches TC[A-Z0-9]{5,10}', p.referral_code ~ '^TC[A-Z0-9]{5,10}$', p.referral_code);
  perform tc_test.ok('provisioning creates a wallet', w.id is not null);
  perform tc_test.eq_num('wallet starts at zero', w.available_balance, 0);
  perform tc_test.eq_num('locked balance starts at zero', w.locked_balance, 0);
  perform tc_test.eq_text('wallet starts ACTIVE', w.status, 'ACTIVE');
end $$;

/* -- credit / debit -------------------------------------------------------- */

do $$
declare
  u1 uuid := (select id from public.profiles where email = 'ledger1@test.invalid');
  tx public.wallet_transactions;
begin
  perform tc_test.fund(u1, 500);

  select * into tx from public.wallet_transactions
   where user_id = u1 and type = 'ADMIN_ADJUSTMENT' order by created_at desc limit 1;

  perform tc_test.eq_num('credit increases available balance', tc_test.available(u1), 500);
  perform tc_test.eq_text('ledger row is COMPLETED', tx.status, 'COMPLETED');
  perform tc_test.eq_text('ledger row direction is CREDIT', tx.direction, 'CREDIT');
  perform tc_test.eq_num('ledger row records the available delta', tx.available_delta, 500);
  perform tc_test.ok('ledger row has a completed_at timestamp', tx.completed_at is not null);

  perform public.wallet_post(
    p_user_id => u1, p_type => 'ADMIN_ADJUSTMENT', p_amount => -200, p_status => 'COMPLETED',
    p_reference => 'TESTDEBIT-' || gen_random_uuid()::text, p_description => 'test debit', p_source => 'TEST');

  perform tc_test.eq_num('debit reduces available balance', tc_test.available(u1), 300);
end $$;

/* -- idempotency ----------------------------------------------------------- */

do $$
declare
  u1 uuid := (select id from public.profiles where email = 'ledger1@test.invalid');
  v_balance numeric;
begin
  perform public.wallet_post(
    p_user_id => u1, p_type => 'VIDEO_REWARD', p_amount => 25, p_status => 'COMPLETED',
    p_reference => 'TESTIDEM-1', p_description => 'idempotency probe', p_source => 'TEST');

  v_balance := tc_test.available(u1);

  -- Same reference again, three times.
  perform public.wallet_post(
    p_user_id => u1, p_type => 'VIDEO_REWARD', p_amount => 25, p_status => 'COMPLETED',
    p_reference => 'TESTIDEM-1', p_description => 'replay', p_source => 'TEST');
  perform public.wallet_post(
    p_user_id => u1, p_type => 'VIDEO_REWARD', p_amount => 25, p_status => 'COMPLETED',
    p_reference => 'TESTIDEM-1', p_description => 'replay', p_source => 'TEST');

  perform tc_test.eq_num('replayed reference credits exactly once', tc_test.available(u1), v_balance);
  perform tc_test.eq_num('replayed reference writes exactly one ledger row', tc_test.ledger_count('TESTIDEM-1'), 1);
end $$;

/* -- reference collisions -------------------------------------------------- */

do $$
declare
  u1 uuid := (select id from public.profiles where email = 'ledger1@test.invalid');
  u2 uuid := (select user2 from t_ledger);
begin
  -- u1 already owns TESTIDEM-1. u2 must not be able to reuse it: a collision
  -- is not a replay, and silently returning u1's row would swallow u2's credit.
  perform tc_test.raises(
    'a reference owned by another account raises LEDGER_REFERENCE_CONFLICT',
    format($q$select public.wallet_post(
              p_user_id => %L::uuid, p_type => 'VIDEO_REWARD', p_amount => 10, p_status => 'COMPLETED',
              p_reference => 'TESTIDEM-1', p_source => 'TEST')$q$, u2),
    'LEDGER_REFERENCE_CONFLICT');
end $$;

/* -- refusals -------------------------------------------------------------- */

do $$
declare
  u1 uuid := (select id from public.profiles where email = 'ledger1@test.invalid');
begin
  perform tc_test.raises('zero amount is refused',
    format($q$select public.wallet_post(p_user_id => %L::uuid, p_type => 'DEPOSIT', p_amount => 0,
      p_status => 'COMPLETED', p_reference => 'TESTZERO-1', p_source => 'TEST')$q$, u1),
    'LEDGER_AMOUNT_INVALID');

  perform tc_test.raises('unknown transaction type is refused',
    format($q$select public.wallet_post(p_user_id => %L::uuid, p_type => 'NOT_A_TYPE', p_amount => 5,
      p_status => 'COMPLETED', p_reference => 'TESTTYPE-1', p_source => 'TEST')$q$, u1),
    'LEDGER_TYPE_INVALID');

  perform tc_test.raises('unknown status is refused',
    format($q$select public.wallet_post(p_user_id => %L::uuid, p_type => 'DEPOSIT', p_amount => 5,
      p_status => 'WHATEVER', p_reference => 'TESTSTATUS-1', p_source => 'TEST')$q$, u1),
    'LEDGER_STATUS_INVALID');

  perform tc_test.raises('short reference is refused',
    format($q$select public.wallet_post(p_user_id => %L::uuid, p_type => 'DEPOSIT', p_amount => 5,
      p_status => 'COMPLETED', p_reference => 'ab', p_source => 'TEST')$q$, u1),
    'LEDGER_REFERENCE_REQUIRED');

  perform tc_test.raises('missing wallet is refused',
    format($q$select public.wallet_post(p_user_id => gen_random_uuid(), p_type => 'DEPOSIT', p_amount => 5,
      p_status => 'COMPLETED', p_reference => 'TESTNOWALLET-1', p_source => 'TEST')$q$),
    'WALLET_NOT_FOUND');
end $$;

/* -- overdraft ------------------------------------------------------------- */

do $$
declare
  u3 uuid := (select user3 from t_ledger);
begin
  perform tc_test.eq_num('a fresh account starts empty', tc_test.available(u3), 0);

  perform tc_test.raises('a hold larger than the available balance is refused',
    format($q$select public.wallet_post(p_user_id => %L::uuid, p_type => 'WITHDRAWAL_HOLD', p_amount => 1,
      p_status => 'COMPLETED', p_reference => 'TESTOVERDRAFT-1', p_source => 'TEST')$q$, u3),
    'INSUFFICIENT_AVAILABLE_BALANCE');

  perform public.wallet_post(
    p_user_id => u3, p_type => 'VIDEO_REWARD', p_amount => 40, p_status => 'COMPLETED',
    p_reference => 'TESTOVERDRAFT-2', p_description => 'seed', p_source => 'TEST');

  perform tc_test.raises('a hold that would go negative is refused',
    format($q$select public.wallet_post(p_user_id => %L::uuid, p_type => 'WITHDRAWAL_HOLD', p_amount => 41,
      p_status => 'COMPLETED', p_reference => 'TESTOVERDRAFT-3', p_source => 'TEST')$q$, u3),
    'INSUFFICIENT_AVAILABLE_BALANCE');

  perform tc_test.ok('available balance never went negative', tc_test.available(u3) >= 0, tc_test.available(u3)::text);

  perform tc_test.raises('releasing more than is locked is refused',
    format($q$select public.wallet_post(p_user_id => %L::uuid, p_type => 'REVERSAL', p_amount => 41,
      p_status => 'COMPLETED', p_reference => 'TESTOVERDRAFT-4', p_source => 'TEST')$q$, u3),
    'INSUFFICIENT_LOCKED_BALANCE');
end $$;

/* -- non-settled statuses do not move money -------------------------------- */

do $$
declare
  u3 uuid := (select user3 from t_ledger);
  before_balance numeric;
begin
  before_balance := tc_test.available(u3);

  perform public.wallet_post(
    p_user_id => u3, p_type => 'DEPOSIT', p_amount => 1000, p_status => 'PENDING',
    p_reference => 'TESTPENDING-1', p_description => 'unconfirmed', p_source => 'TEST');

  perform tc_test.eq_num('a PENDING ledger row does not move money', tc_test.available(u3), before_balance);
  perform tc_test.eq_num('a PENDING row is still recorded', tc_test.ledger_count('TESTPENDING-1'), 1);
end $$;

/* -- ledger immutability --------------------------------------------------- */

do $$
declare
  u1 uuid := (select id from public.profiles where email = 'ledger1@test.invalid');
begin
  perform tc_test.raises('ledger rows cannot be updated',
    format($q$update public.wallet_transactions set amount = 999999
              where user_id = %L::uuid and reference = 'TESTIDEM-1'$q$, u1),
    'LEDGER_IMMUTABLE');

  perform tc_test.raises('ledger rows cannot be deleted',
    format($q$delete from public.wallet_transactions
              where user_id = %L::uuid and reference = 'TESTIDEM-1'$q$, u1),
    'LEDGER_IMMUTABLE');
end $$;

/* -- frozen and closed wallets --------------------------------------------- */

do $$
declare
  u3 uuid := (select user3 from t_ledger);
begin
  perform public.wallet_post(
    p_user_id => u3, p_type => 'VIDEO_REWARD', p_amount => 100, p_status => 'COMPLETED',
    p_reference => 'TESTFREEZE-1', p_description => 'seed for freeze', p_source => 'TEST');

  update public.wallets set status = 'FROZEN', frozen_reason = 'test' where user_id = u3;

  perform tc_test.raises('a frozen wallet refuses outbound money',
    format($q$select public.wallet_post(p_user_id => %L::uuid, p_type => 'WITHDRAWAL_HOLD', p_amount => 1,
      p_status => 'COMPLETED', p_reference => 'TESTFREEZE-2', p_source => 'TEST')$q$, u3),
    'WALLET_FROZEN');

  -- A freeze must never trap money: funds already held still come back.
  update public.wallets set status = 'ACTIVE' where user_id = u3;
  perform public.wallet_post(
    p_user_id => u3, p_type => 'WITHDRAWAL_HOLD', p_amount => 10, p_status => 'COMPLETED',
    p_reference => 'TESTFREEZE-3', p_description => 'hold', p_source => 'TEST');
  update public.wallets set status = 'FROZEN' where user_id = u3;

  perform public.wallet_post(
    p_user_id => u3, p_type => 'WITHDRAWAL_RELEASE', p_amount => 10, p_status => 'COMPLETED',
    p_reference => 'TESTFREEZE-4', p_description => 'release while frozen', p_source => 'TEST');

  perform tc_test.eq_num('a frozen wallet still releases held funds', tc_test.locked(u3), 0);

  update public.wallets set status = 'CLOSED' where user_id = u3;

  perform tc_test.raises('a closed wallet refuses even a credit',
    format($q$select public.wallet_post(p_user_id => %L::uuid, p_type => 'DEPOSIT', p_amount => 5,
      p_status => 'COMPLETED', p_reference => 'TESTCLOSED-1', p_source => 'TEST')$q$, u3),
    'WALLET_CLOSED');

  update public.wallets set status = 'ACTIVE', frozen_reason = null where user_id = u3;
end $$;
