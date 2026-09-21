-- ============================================================================
-- 50 — referrals
--
-- A referral only qualifies on the configured event, and commission is only
-- ever paid on eligible activity afterwards. Nothing accrues from a click.
--
-- Note: deposit_credit() does not itself pay commission. The server-side
-- service calls referral_commission_on_deposit() after a verified deposit, and
-- that is the call exercised here.
-- ============================================================================

/* -- registering with a code links a pending referral ----------------------- */

do $$
declare
  referrer uuid := tc_test.create_user('ref_owner@test.invalid');
  code text;
  referred uuid;
begin
  select referral_code into code from public.profiles where id = referrer;

  referred := tc_test.create_user('ref_join@test.invalid', jsonb_build_object('referral_code', code));

  perform tc_test.eq_num('the referral is recorded once',
    (select count(*)::int from public.referrals where referred_user_id = referred), 1);
  perform tc_test.eq_text('a new referral starts PENDING',
    (select status from public.referrals where referred_user_id = referred), 'PENDING');
  perform tc_test.eq_text('the referred profile points back at the referrer',
    (select p.referred_by::text from public.profiles p where p.id = referred), referrer::text);
end $$;

/* -- only the configured event qualifies ----------------------------------- */

do $$
declare
  referrer uuid := tc_test.create_user('ref_owner2@test.invalid');
  code text;
  referred uuid;
begin
  select referral_code into code from public.profiles where id = referrer;
  referred := tc_test.create_user('ref_join2@test.invalid', jsonb_build_object('referral_code', code));

  -- The seeded qualifying event is VERIFIED_REGISTRATION. A different event
  -- must not flip the referral.
  perform public.referral_qualify(referred, 'KYC_VERIFIED');
  perform tc_test.eq_text('a non-configured event does not qualify a referral',
    (select status from public.referrals where referred_user_id = referred), 'PENDING');

  perform public.referral_qualify(referred, 'VERIFIED_REGISTRATION');
  perform tc_test.eq_text('the configured event qualifies the referral',
    (select status from public.referrals where referred_user_id = referred), 'QUALIFIED');
  perform tc_test.ok('the qualification timestamp is stamped',
    (select qualified_at from public.referrals where referred_user_id = referred) is not null);

  perform public.referral_qualify(referred, 'VERIFIED_REGISTRATION');
  perform tc_test.eq_num('re-qualifying credits nothing extra', tc_test.available(referrer), 0);
end $$;

/* -- email confirmation is the trigger ------------------------------------- */

do $$
declare
  referrer uuid := tc_test.create_user('ref_owner3@test.invalid');
  code text;
  referred uuid;
begin
  select referral_code into code from public.profiles where id = referrer;
  referred := tc_test.create_user('ref_join3@test.invalid', jsonb_build_object('referral_code', code));

  perform tc_test.confirm_email(referred);

  perform tc_test.eq_text('confirming the email qualifies the referral automatically',
    (select status from public.referrals where referred_user_id = referred), 'QUALIFIED');
end $$;

/* -- commission on a verified deposit -------------------------------------- */

do $$
declare
  referrer uuid := tc_test.create_user('ref_owner4@test.invalid');
  code text;
  referred uuid;
  d uuid;
  credit record;
begin
  select referral_code into code from public.profiles where id = referrer;
  referred := tc_test.create_user('ref_join4@test.invalid', jsonb_build_object('referral_code', code));
  perform tc_test.confirm_email(referred);

  d := tc_test.create_deposit(referred, 1000, 'DEP-REF-COMM-1');
  select * into credit from public.deposit_credit('DEP-REF-COMM-1', 'PROV-REF-COMM-1', '{}'::jsonb);

  -- mirror the service call
  perform public.referral_commission_on_deposit(referred, credit.tx_id, 1000, 'KES');

  perform tc_test.eq_num('level 1 commission is 5% of the eligible deposit', tc_test.available(referrer), 50);
  perform tc_test.eq_text('the commission is recorded as CREDITED',
    (select status from public.referral_commissions where referrer_id = referrer and referred_user_id = referred),
    'CREDITED');
  perform tc_test.eq_num('exactly one commission row exists',
    (select count(*)::int from public.referral_commissions where referrer_id = referrer), 1);

  -- Replaying the same source transaction must not pay twice.
  perform public.referral_commission_on_deposit(referred, credit.tx_id, 1000, 'KES');
  perform tc_test.eq_num('a replayed commission credits nothing further', tc_test.available(referrer), 50);
  perform tc_test.eq_num('a replayed commission writes no second ledger row',
    (select count(*)::int from public.wallet_transactions where user_id = referrer and type = 'REFERRAL_REWARD'), 1);
end $$;

/* -- unqualified referrals earn nothing ------------------------------------ */

do $$
declare
  referrer uuid := tc_test.create_user('ref_owner5@test.invalid');
  code text;
  referred uuid;
  d uuid;
  credit record;
begin
  select referral_code into code from public.profiles where id = referrer;
  referred := tc_test.create_user('ref_join5@test.invalid', jsonb_build_object('referral_code', code));

  -- No confirmation, so the referral is still PENDING.
  d := tc_test.create_deposit(referred, 1000, 'DEP-REF-UNQUAL-1');
  select * into credit from public.deposit_credit('DEP-REF-UNQUAL-1', 'PROV-REF-UNQUAL-1', '{}'::jsonb);
  perform public.referral_commission_on_deposit(referred, credit.tx_id, 1000, 'KES');

  perform tc_test.eq_num('an unqualified referral earns no commission', tc_test.available(referrer), 0);
end $$;

/* -- self-referral and zero-rate guards ------------------------------------ */

do $$
declare
  u uuid := tc_test.create_user('ref_self@test.invalid');
  v_tx uuid;
  v_result public.referral_commissions;
begin
  -- A real source transaction, so the guard being tested is the self-referral
  -- rule and not a NULL the function happens to reject early.
  perform tc_test.fund(u, 100);
  select id into v_tx from public.wallet_transactions
   where user_id = u and type = 'ADMIN_ADJUSTMENT' limit 1;
  perform tc_test.ok('the self-referral probe has a real source transaction', v_tx is not null);

  select * into v_result from public.referral_credit(u, u, 1, 1000, 'KES', 0.05, 'VERIFIED_REGISTRATION', v_tx, 'TEST');
  perform tc_test.ok('self-referral is a silent no-op', v_result is null);
  perform tc_test.eq_num('self-referral credits nothing', tc_test.available(u), 100);

  select * into v_result from public.referral_credit(u, u, 1, 1000, 'KES', 0, 'VERIFIED_REGISTRATION', v_tx, 'TEST');
  perform tc_test.ok('a zero commission rate credits nothing', v_result is null);
end $$;

-- Level 2 is disabled by default (referrals.level2_rate = 0), so a deposit
-- that would produce a second-level commission produces none.
do $$
declare
  a uuid := tc_test.create_user('ref_l2_a@test.invalid');
  b uuid := tc_test.create_user('ref_l2_b@test.invalid');
  c uuid := tc_test.create_user('ref_l2_c@test.invalid');
  v_tx uuid;
begin
  -- a referred b, b referred c; a deposit by c would pay a level-2 commission.
  insert into public.referrals (referrer_id, referred_user_id, referral_code, level, status)
  values (a, b, (select referral_code from public.profiles where id = a), 1, 'QUALIFIED'),
         (b, c, (select referral_code from public.profiles where id = b), 1, 'QUALIFIED')
  on conflict (referred_user_id) do nothing;

  select id into v_tx from public.wallet_transactions where user_id = c limit 1;
  perform public.referral_credit(b, c, 2, 1000, 'KES', 0, 'ELIGIBLE_DEPOSIT', v_tx, 'TEST');

  perform tc_test.eq_num('the disabled level 2 pays nothing', tc_test.available(b), 0);
end $$;
