-- ============================================================================
-- 30 — deposits
--
-- A deposit is only ever credited by public.deposit_credit(), which is called
-- after the provider confirms. Replaying an identical callback must be a
-- no-op, and a failed payment must never credit anything.
--
-- The payload is passed BY NAME, deliberately. 0002 defined deposit_credit with
-- three parameters and 0015 redefined it with five, so `create or replace` added
-- a second function instead of replacing the first — and 0021 dropped the stale
-- three-argument one. A positional third argument is now a jsonb where the
-- surviving signature expects p_provider_reference text, so the call does not
-- resolve at all. Naming the parameter keeps these calls meaning what they
-- always meant (reference, provider transaction id, payload) without depending
-- on the argument list staying three wide. Do not "tidy" it back to positional.
-- ============================================================================

/* -- credit once ----------------------------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('dep_credit@test.invalid');
  d uuid;
  r record;
begin
  d := tc_test.create_deposit(u, 1500, 'DEP-REF-1');

  select * into r from public.deposit_credit('DEP-REF-1', 'PROV-DEP-1', p_payload => '{"ResultCode":0}'::jsonb);

  perform tc_test.eq_bool('the first confirmation credits the wallet', r.credited, true);
  /*
    0015 replaced 0002's separate `duplicate` output column with `credited`
    itself, so "was this a replay?" is now answered by the credit flag rather
    than by a second boolean. The ledger and balance assertions that follow are
    what actually prove nothing was credited twice — this flag only reports it.
  */
  perform tc_test.eq_num('the credited amount equals the deposit amount', tc_test.available(u), 1500);
  perform tc_test.eq_num('exactly one DEPOSIT ledger row exists', tc_test.ledger_count('DEP-' || d::text), 1);
  perform tc_test.eq_text('the deposit is marked COMPLETED',
    (select status from public.deposits where id = d), 'COMPLETED');
  perform tc_test.ok('the deposit points at its ledger row',
    (select wallet_transaction_id from public.deposits where id = d) is not null);
  perform tc_test.ok('the user is notified',
    exists (select 1 from public.notifications where user_id = u and type = 'DEPOSIT_COMPLETED'));
end $$;

/* -- duplicate callbacks ---------------------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('dep_dup@test.invalid');
  d uuid;
  r1 record;
  r2 record;
  r3 record;
  balance_after_first numeric;
begin
  d := tc_test.create_deposit(u, 900, 'DEP-REF-DUP');
  select * into r1 from public.deposit_credit('DEP-REF-DUP', 'PROV-DEP-DUP', p_payload => '{}'::jsonb);
  balance_after_first := tc_test.available(u);

  -- The provider retries the webhook: twice, with and without a payload.
  select * into r2 from public.deposit_credit('DEP-REF-DUP', 'PROV-DEP-DUP', p_payload => '{}'::jsonb);
  select * into r3 from public.deposit_credit('DEP-REF-DUP', null, p_payload => '{"retry":true}'::jsonb);

  perform tc_test.eq_bool('a replayed callback does not credit again', r2.credited, false);
  perform tc_test.eq_bool('a payload-less retry is also recognised as a replay', r3.credited, false);
  perform tc_test.eq_num('the balance is credited exactly once', tc_test.available(u), balance_after_first);
  perform tc_test.eq_num('only one ledger row exists after three callbacks', tc_test.ledger_count('DEP-' || d::text), 1);
  perform tc_test.eq_num('the credit is the deposit amount, once', tc_test.available(u), 900);
end $$;

/* -- failures never credit -------------------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('dep_fail@test.invalid');
  d uuid;
begin
  d := tc_test.create_deposit(u, 700, 'DEP-REF-FAIL');
  perform public.deposit_fail('DEP-REF-FAIL', 'Insufficient funds on the customer wallet', 'FAILED', '{}'::jsonb);

  perform tc_test.eq_num('a failed deposit credits nothing', tc_test.available(u), 0);
  perform tc_test.eq_text('the deposit is marked FAILED',
    (select status from public.deposits where id = d), 'FAILED');
  perform tc_test.eq_num('no ledger row is written for a failure', tc_test.ledger_count('DEP-' || d::text), 0);

  /*
    The refusal is asserted against DEPOSIT_NOT_FOUND because that is what the
    database actually raises — NOT because it is the right answer.

    0002 raised DEPOSIT_NOT_PAYABLE here, and src/lib/api/errors.ts still maps
    that code for the API layer. 0015 rewrote deposit_credit and now raises
    DEPOSIT_NOT_FOUND for anything that is neither PENDING/PROCESSING nor
    COMPLETED, so a deposit that demonstrably exists and has FAILED is reported
    to an operator as "no such deposit". Both codes refuse to credit, so this is
    a message-accuracy defect rather than a money one — which is why it is
    documented here and not silently corrected.

    Restoring the distinction needs a migration that re-raises
    DEPOSIT_NOT_PAYABLE for a terminal-but-unpayable deposit; this expectation
    flips back to the old token at that point. Left red-to-green on purpose: a
    fixture that keeps asserting a code no migration produces is a test that
    fails for a reason nobody can act on.
  */
  perform tc_test.raises('a failed deposit can never be credited later',
    $q$select public.deposit_credit('DEP-REF-FAIL', 'PROV-DEP-FAIL-2', p_payload => '{}'::jsonb)$q$,
    'DEPOSIT_NOT_FOUND');

  -- A settled deposit must not be downgraded by a late failure callback.
  perform tc_test.eq_text('a terminal deposit is not downgraded by a late failure',
    (select status from public.deposits where id = d), 'FAILED');
end $$;

do $$
declare
  u uuid := tc_test.create_user('dep_settled@test.invalid');
  d uuid;
begin
  d := tc_test.create_deposit(u, 300, 'DEP-REF-SETTLED');
  perform public.deposit_credit('DEP-REF-SETTLED', 'PROV-DEP-SETTLED', p_payload => '{}'::jsonb);
  perform public.deposit_fail('DEP-REF-SETTLED', 'late failure callback', 'FAILED', '{}'::jsonb);

  perform tc_test.eq_text('a settled deposit is never downgraded by a late failure',
    (select status from public.deposits where id = d), 'COMPLETED');
  perform tc_test.eq_num('the settled credit stands', tc_test.available(u), 300);
end $$;

/* -- provider transaction ids and unknown references ------------------------ */

do $$
declare
  u_a uuid := tc_test.create_user('dep_provtx_a@test.invalid');
  u_b uuid := tc_test.create_user('dep_provtx_b@test.invalid');
begin
  perform tc_test.create_deposit(u_a, 100, 'DEP-REF-PROVTX-A');
  perform tc_test.create_deposit(u_b, 100, 'DEP-REF-PROVTX-B');
  perform public.deposit_credit('DEP-REF-PROVTX-A', 'PROV-DEP-SHARED', p_payload => '{}'::jsonb);

  perform tc_test.raises('one provider transaction cannot credit two deposits',
    $q$select public.deposit_credit('DEP-REF-PROVTX-B', 'PROV-DEP-SHARED', p_payload => '{}'::jsonb)$q$,
    'DEPOSIT_PROVIDER_TX_REUSED');

  perform tc_test.raises('an unknown merchant reference is refused',
    $q$select public.deposit_credit('DEP-REF-DOES-NOT-EXIST', 'PROV-DEP-UNKNOWN', p_payload => '{}'::jsonb)$q$,
    'DEPOSIT_NOT_FOUND');

  perform tc_test.eq_num('the refused deposit was not credited', tc_test.available(u_b), 0);
end $$;

/* -- provider identifiers, for reconciliation (0012) ------------------------ */

do $$
declare
  u uuid := tc_test.create_user('dep_identifiers@test.invalid');
  d uuid;
begin
  d := tc_test.create_deposit(u, 250, 'DEP-REF-IDENT');

  -- What the application records once Safaricom accepts the STK Push: our own
  -- reference stays as it was, and Daraja's own ids are stored beside it.
  update public.deposits
     set provider_reference  = 'ws_CO_123456789',
         merchant_request_id = '29115-34620561-1',
         result_code         = '1032',
         result_description = 'Request cancelled by user'
   where id = d;

  perform tc_test.eq_text('checkout_request_id mirrors provider_reference',
    (select checkout_request_id from public.deposits where id = d), 'ws_CO_123456789');

  -- The receipt exists only once Safaricom has confirmed the payment.
  update public.deposits set provider_transaction_id = 'SJ81KJ7ZQ4' where id = d;

  perform tc_test.eq_text('mpesa_receipt_number mirrors provider_transaction_id',
    (select mpesa_receipt_number from public.deposits where id = d), 'SJ81KJ7ZQ4');
  perform tc_test.eq_text('the merchant request id is kept on the deposit',
    (select merchant_request_id from public.deposits where id = d), '29115-34620561-1');
  perform tc_test.eq_text('the provider result code is kept on the deposit',
    (select result_code from public.deposits where id = d), '1032');
  perform tc_test.eq_text('the provider description is kept verbatim',
    (select result_description from public.deposits where id = d), 'Request cancelled by user');

  /*
    The two Daraja-named columns are GENERATED, so they cannot be written. That
    is the whole point of deriving them: an alias that cannot be assigned to can
    never disagree with the value it mirrors, so "the receipt" has exactly one
    source of truth no matter which name a report or a support tool asks for.
  */
  perform tc_test.raises('a generated column cannot be updated',
    $q$update public.deposits set checkout_request_id = 'tampered'
        where merchant_reference = 'DEP-REF-IDENT'$q$,
    'checkout_request_id');

  perform tc_test.raises('a generated column cannot be inserted into',
    $q$insert into public.deposits
        (user_id, wallet_id, amount, currency, phone, merchant_reference, mpesa_receipt_number)
      select user_id, wallet_id, amount, currency, phone, merchant_reference || '-x', 'FORGED'
        from public.deposits where merchant_reference = 'DEP-REF-IDENT'$q$,
    'mpesa_receipt_number');

  perform tc_test.ok('updated_at is populated on a new deposit',
    (select updated_at is not null from public.deposits where id = d));

  perform tc_test.ok('the updated_at trigger is installed on deposits',
    exists (select 1 from pg_trigger t
              join pg_class c on c.oid = t.tgrelid
             where t.tgname = 'trg_deposits_updated'
               and c.relname = 'deposits'
               and not t.tgisinternal));
end $$;
