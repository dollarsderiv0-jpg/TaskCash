-- ============================================================================
-- 86 — idempotency claims (the duplicate-click guard)
--
--   claim_idempotency_key() is what stops a double submit — a double-tapped
--   "Pay with M-Pesa", or a client retrying after a timeout it never saw
--   answered — from creating a second deposit and therefore a second STK prompt
--   and a second charge.
--
--   The whole guard is one primary key and one exception handler, so it is
--   exactly the kind of thing that looks obviously right and is worth asserting:
--   the insert must be atomic, the second claim must be refused WITHOUT raising
--   (a raise would surface to the customer as a failed payment), and refused
--   claims must not accumulate rows.
--
--   This file exists because no test exercised this function before.
-- ============================================================================

/* -- one key, one claim ----------------------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('idempotency@test.invalid');
  first_claim  boolean;
  second_claim boolean;
  other_claim  boolean;
begin
  first_claim := public.claim_idempotency_key('TCID-TEST-0001', u, 'deposit');
  perform tc_test.ok('the first claim of a key succeeds', first_claim);

  /*
    The decisive one. This is the double-click: the same key arrives twice. It
    must be REFUSED, and refused by returning false rather than by raising —
    the caller treats false as "this request already exists" and answers the
    customer with the original deposit instead of an error.
  */
  second_claim := public.claim_idempotency_key('TCID-TEST-0001', u, 'deposit');
  perform tc_test.ok('a second claim of the SAME key is refused', not second_claim);

  perform tc_test.eq_num('a refused claim does not create a second row',
    (select count(*)::int from public.idempotency_keys where key = 'TCID-TEST-0001'), 1);

  perform tc_test.eq_text('the claim records the user it belongs to',
    (select user_id::text from public.idempotency_keys where key = 'TCID-TEST-0001'),
    u::text);
  perform tc_test.eq_text('the claim records its scope',
    (select scope from public.idempotency_keys where key = 'TCID-TEST-0001'), 'deposit');

  other_claim := public.claim_idempotency_key('TCID-TEST-0002', u, 'deposit');
  perform tc_test.ok('a different key is still claimable', other_claim);

  /*
    The key is the primary key on its own, so it is unique across the whole table
    rather than per user or per scope. Asserted as the real behaviour rather than
    the desirable-looking one: it means a client must mint a genuinely unique key
    per attempt, which is why the frontend prefixes it with the action name.
  */
  perform tc_test.ok('the same key is refused even in a different scope',
    not public.claim_idempotency_key('TCID-TEST-0001', u, 'withdrawal'));
  perform tc_test.ok('...and even for a different user',
    not public.claim_idempotency_key(
      'TCID-TEST-0001', tc_test.create_user('idempotency2@test.invalid'), 'deposit'));
end $$;


/* -- many repeats still leave one row -------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('idempotency3@test.invalid');
  v_refused int := 0;
  i int;
begin
  /*
    A user who keeps pressing the button, or a client that retries in a loop. Ten
    attempts, one key: the guard must be stable under repetition, because the
    failure it prevents is a duplicate charge.
  */
  for i in 1..10 loop
    if not public.claim_idempotency_key('TCID-TEST-REPEAT', u, 'deposit') then
      v_refused := v_refused + 1;
    end if;
  end loop;

  perform tc_test.eq_num('one of ten attempts won the claim', 10 - v_refused, 1);
  perform tc_test.eq_num('...and nine were refused', v_refused, 9);
  perform tc_test.eq_num('...leaving exactly one key row',
    (select count(*)::int from public.idempotency_keys where key = 'TCID-TEST-REPEAT'), 1);
end $$;


/* -- cleanup --------------------------------------------------------------- */

delete from public.idempotency_keys where key like 'TCID-TEST-%';

do $$
begin
  perform tc_test.eq_num('the fixtures are removed',
    (select count(*)::int from public.idempotency_keys where key like 'TCID-TEST-%'), 0);
end $$;
