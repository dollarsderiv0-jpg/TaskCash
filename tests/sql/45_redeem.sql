-- ============================================================================
-- 45_redeem.sql — a redeem code credits the CALLER, and exactly once
--
-- This file exists because NOTHING tested redeem_code, and two independent
-- faults hid behind that silence:
--
--   1. /api/redeem called it with the service-role client. That client carries
--      no user token, so auth.uid() was null and the function raised
--      UNAUTHORIZED before it ever looked at the code.
--   2. With an identity supplied, the function still could not credit anyone:
--      it used the AUTH user id as `p_user_id`, while wallets, wallet_transactions
--      and notifications are all keyed by the PROFILE id. profiles.auth_user_id
--      is a separate column and is never equal to profiles.id.
--
-- Neither fault is visible from a happy path alone, so the identity is set
-- explicitly here (`request.jwt.claim.sub`, the same setting PostgREST fills)
-- and the BENEFICIARY is asserted rather than assumed — that is the assertion
-- that fails on the old function.
--
-- The identity is reset at the end of this file on purpose: the runner executes
-- every file inside one transaction, so a claim left set here would still be in
-- force for 50_referrals.sql and beyond.
-- ============================================================================

/* -- credits the caller's own wallet, once, keyed by the profile ----------- */
do $redeem$
declare
  u        uuid;
  v_auth   uuid;
  v_code   uuid;
  v_before numeric;
  r        jsonb;
begin
  u := tc_test.create_user('redeem-happy@test.local');
  select auth_user_id into v_auth from public.profiles where id = u;

  insert into public.redeem_codes (code, amount, currency, max_redemptions, status)
  values ('TC-HAPPY-50', 50, 'KES', 3, 'ACTIVE')
  returning id into v_code;

  -- The only thing that identifies the caller, supplied the way PostgREST does.
  perform set_config('request.jwt.claim.sub', v_auth::text, true);

  v_before := tc_test.available(u);
  r := public.redeem_code('TC-HAPPY-50');

  perform tc_test.eq_num(
    'a redeem code credits its own amount to the caller',
    tc_test.available(u) - v_before,
    50
  );
  perform tc_test.eq_num(
    'exactly one REDEEM ledger row is written',
    (select count(*)::int from public.wallet_transactions
      where reference like 'REDEEM-' || v_code::text || '-%')::numeric,
    1
  );
  /*
    The assertion that the old function fails. `user_id` here is a PROFILE id,
    so comparing it to the profile — not to the auth user id — is what proves the
    credit landed on the right account.
  */
  perform tc_test.eq_text(
    'the ledger row is keyed to the PROFILE id, not the auth user id',
    (select user_id::text from public.wallet_transactions
      where reference like 'REDEEM-' || v_code::text || '-%' limit 1),
    u::text
  );
  perform tc_test.eq_num(
    'the redemption counter advances',
    (select redemptions_used::int from public.redeem_codes where id = v_code)::numeric,
    1
  );
  perform tc_test.eq_num('the response reports the credit', (r->>'amount')::numeric, 50);
  perform tc_test.eq_num('the response reports remaining redemptions', (r->>'remaining')::numeric, 2);

  -- Replaying the same code must not pay twice.
  perform tc_test.raises(
    'a second redemption of the same code is refused',
    $q$select public.redeem_code('TC-HAPPY-50')$q$,
    'REDEEM_ALREADY_USED'
  );
  perform tc_test.eq_num('a replay credits nothing further', tc_test.available(u) - v_before, 50);
  perform tc_test.eq_num(
    'a replay writes no second ledger row',
    (select count(*)::int from public.wallet_transactions
      where reference like 'REDEEM-' || v_code::text || '-%')::numeric,
    1
  );

  perform tc_test.raises(
    'an unknown code is refused',
    $q$select public.redeem_code('TC-NOT-A-REAL-CODE')$q$,
    'REDEEM_CODE_INVALID'
  );
end $redeem$;

/* -- without an identity, nothing is credited ------------------------------ */
do $redeem$
declare
  u uuid;
begin
  u := tc_test.create_user('redeem-anon@test.local');

  perform set_config('request.jwt.claim.sub', '', true);
  perform tc_test.raises(
    'an anonymous caller cannot redeem at all',
    $q$select public.redeem_code('TC-HAPPY-50')$q$,
    'UNAUTHORIZED'
  );
  perform tc_test.eq_num('a refused redemption credits nothing', tc_test.available(u), 0);
end $redeem$;

/* -- a multi-use code credits EACH caller their own amount ----------------- */
do $redeem$
declare
  u1 uuid;
  u2 uuid;
  a1 uuid;
  a2 uuid;
  c  uuid;
  b1 numeric;
  b2 numeric;
begin
  u1 := tc_test.create_user('redeem-first@test.local');
  u2 := tc_test.create_user('redeem-second@test.local');
  select auth_user_id into a1 from public.profiles where id = u1;
  select auth_user_id into a2 from public.profiles where id = u2;

  insert into public.redeem_codes (code, amount, currency, max_redemptions, status)
  values ('TC-SHARED-70', 70, 'KES', 2, 'ACTIVE')
  returning id into c;

  perform set_config('request.jwt.claim.sub', a1::text, true);
  b1 := tc_test.available(u1);
  perform public.redeem_code('TC-SHARED-70');

  perform set_config('request.jwt.claim.sub', a2::text, true);
  b2 := tc_test.available(u2);
  perform public.redeem_code('TC-SHARED-70');

  perform tc_test.eq_num('the first caller is credited', tc_test.available(u1) - b1, 70);
  perform tc_test.eq_num('the second caller is credited', tc_test.available(u2) - b2, 70);
  perform tc_test.eq_num(
    'the second redemption does not touch the first caller',
    tc_test.available(u1) - b1,
    70
  );
  perform tc_test.eq_num(
    'both redemptions are counted',
    (select redemptions_used::int from public.redeem_codes where id = c)::numeric,
    2
  );
  perform tc_test.eq_text(
    'a fully redeemed code retires itself',
    (select status from public.redeem_codes where id = c),
    'EXPIRED'
  );
  /*
    Documented drift, asserted as it actually behaves. REDEEM_CODE_EXHAUSTED is
    unreachable: the counter increment sets status='EXPIRED' the moment the last
    redemption is used, and the lookup only ever selects status='ACTIVE'. So the
    next attempt reads INVALID rather than EXHAUSTED — and src/lib/api/errors.ts
    still maps an EXHAUSTED message to "that code has already been fully
    redeemed". Refusing is correct either way; only the wording is unreachable.
  */
  perform tc_test.raises(
    'a retired code reads as invalid, not as exhausted',
    $q$select public.redeem_code('TC-SHARED-70')$q$,
    'REDEEM_CODE_INVALID'
  );
end $redeem$;

/* -- expiry ---------------------------------------------------------------- */
do $redeem$
declare
  u uuid;
  a uuid;
  c uuid;
begin
  u := tc_test.create_user('redeem-expired@test.local');
  select auth_user_id into a from public.profiles where id = u;

  insert into public.redeem_codes (code, amount, max_redemptions, status, expires_at)
  values ('TC-EXPIRED-30', 30, 5, 'ACTIVE', now() - interval '1 day')
  returning id into c;

  perform set_config('request.jwt.claim.sub', a::text, true);

  perform tc_test.raises(
    'an expired code is refused',
    $q$select public.redeem_code('TC-EXPIRED-30')$q$,
    'REDEEM_CODE_EXPIRED'
  );
  perform tc_test.eq_num('an expired code credits nothing', tc_test.available(u), 0);

  /*
    The function updates the row to EXPIRED immediately before raising. That
    update cannot survive: `raise` aborts the transaction, so the subtransaction
    is rolled back and the row goes back to ACTIVE. This is not a quirk of the
    harness — `tc_test.raises` reproduces exactly what PostgREST does, because a
    statement that raises rolls its work back there too.

    Consequence: the retirement is dead code. An expired code stays ACTIVE and
    is refused on every later attempt by the `expires_at` test instead, which is
    the correct outcome — the drift is that no operator will ever see it marked
    EXPIRED, and `redeem_codes.status` therefore carries no information about
    expiry. Asserted as it behaves, so a future change that makes the write land
    is a visible failure here rather than a silent difference.
  */
  perform tc_test.eq_text(
    'the expiry retirement is discarded with the refusal, so the code stays ACTIVE',
    (select status from public.redeem_codes where id = c),
    'ACTIVE'
  );
end $redeem$;

/* -- an auth user with no profile is named, not misreported as a wallet ---- */
do $redeem$
declare
  a uuid;
begin
  insert into auth.users (email, raw_user_meta_data, email_confirmed_at)
  values ('redeem-noprofile@test.local', '{}'::jsonb, now())
  returning id into a;

  -- Simulate an account the provisioning trigger never reached.
  delete from public.profiles where auth_user_id = a;

  perform set_config('request.jwt.claim.sub', a::text, true);
  perform tc_test.raises(
    'an auth user with no profile is refused by name',
    $q$select public.redeem_code('TC-HAPPY-50')$q$,
    'PROFILE_NOT_FOUND'
  );
end $redeem$;

/* -- leave the runner as we found it --------------------------------------- */
do $redeem$
begin
  perform set_config('request.jwt.claim.sub', '', true);
end $redeem$;
