-- ============================================================================
-- 85 — provider-side reconciliation alerts
--
--   The provider sweep is the only check in the product that starts from the
--   provider rather than from a local record, so it is the only one that can
--   notice money taken and never credited. It reports what it finds by writing
--   rows here. If those rows cannot be written, the sweep finds the money and
--   then silently fails to report it — which is worse than not running, because
--   the run looks complete.
--
--   So these assertions are about the reporting contract, not about payments:
--     · every alert type the sweep raises is accepted (0001's CHECK allows it),
--     · a provider-only finding may carry NO local record (entity_id null),
--     · the dedupe query the sweep runs finds an open alert, and does not block
--       a fresh one once the previous is resolved.
-- ============================================================================

/* -- the alert types the sweep can raise ------------------------------------ */
--
-- Insert each one for real rather than trusting the CHECK's text. The last
-- assertion proves the CHECK is actually enforced, so the list above is a
-- meaningful boundary rather than a comment.

do $$
declare
  v_id uuid;
begin
  insert into public.reconciliation_alerts
    (alert_type, severity, entity_type, entity_id, reference, details)
  values
    ('PROVIDER_COMPLETED_MISSING_LOCAL', 'CRITICAL', 'provider_transaction', null,
      'SWEEP-TEST-MISSING-1',
      jsonb_build_object('providerReference', 'PH-1', 'receipt', 'REC-1', 'amount', 800))
  returning id into v_id;
  perform tc_test.ok('a paid payment with no local deposit is reportable', v_id is not null);

  insert into public.reconciliation_alerts
    (alert_type, severity, entity_type, entity_id, reference, details)
  values
    ('PAYMENT_NOT_CREDITED', 'CRITICAL', 'deposit', gen_random_uuid()::text,
      'SWEEP-TEST-NOTCREDITED-1', jsonb_build_object('amount', 800))
  returning id into v_id;
  perform tc_test.ok('a paid payment we had closed as failed is reportable', v_id is not null);

  insert into public.reconciliation_alerts
    (alert_type, severity, entity_type, entity_id, reference, details)
  values
    ('AMOUNT_MISMATCH', 'HIGH', 'deposit', gen_random_uuid()::text,
      'SWEEP-TEST-MISMATCH-1', jsonb_build_object('expected', 800, 'provider', 500))
  returning id into v_id;
  perform tc_test.ok('a paid payment for the wrong amount is reportable', v_id is not null);

  /*
    A distinct dollar-quote tag is used for the SQL passed to raises(), because
    a nested identical tag would close the enclosing do-block early and leave
    the statement parsed as top-level SQL.
  */
  perform tc_test.raises('an alert type outside the CHECK is refused',
    $raises$insert into public.reconciliation_alerts(alert_type, severity, entity_type, reference)
      values ('MADE_UP_TYPE', 'HIGH', 'deposit', 'SWEEP-TEST-BOGUS')$raises$,
    'reconciliation_alerts_alert_type_check');
end $$;


/* -- a provider-only finding has no local record ---------------------------- */

do $$
declare
  v_entity text;
begin
  /*
    This is the shape of the case the sweep exists for: the provider took the
    money and no deposit exists, so there is nobody to credit and nothing to
    link to. An implementation that required entity_id could only report the
    cases we already knew about — which is the opposite of the point.
  */
  select entity_id into v_entity
    from public.reconciliation_alerts
   where reference = 'SWEEP-TEST-MISSING-1';

  perform tc_test.ok('a finding with no local record stores a null entity_id',
    v_entity is null);
  perform tc_test.eq_text('...and keeps the reference an operator searches on',
    (select reference from public.reconciliation_alerts where reference = 'SWEEP-TEST-MISSING-1'),
    'SWEEP-TEST-MISSING-1');
end $$;


/* -- the dedupe the sweep runs ---------------------------------------------- */
--
-- The sweep runs on a schedule and on demand, and it raises an alert only when
-- one is not already open for the same reference and type. A queue that grows by
-- one row per run is a queue an operator stops reading.

do $$
declare
  v_found uuid;
  v_count int;
begin
  select id into v_found
    from public.reconciliation_alerts
   where reference = 'SWEEP-TEST-MISSING-1'
     and alert_type = 'PROVIDER_COMPLETED_MISSING_LOCAL'
     and status = 'OPEN'
   limit 1;

  perform tc_test.ok('the dedupe query finds the open alert', v_found is not null);

  -- An open alert for a *different* type on the same reference must not be
  -- mistaken for a duplicate: the two mean different things and both are needed.
  select id into v_found
    from public.reconciliation_alerts
   where reference = 'SWEEP-TEST-MISSING-1'
     and alert_type = 'AMOUNT_MISMATCH'
     and status = 'OPEN'
   limit 1;
  perform tc_test.ok('...and does not confuse a different alert type for a duplicate',
    v_found is null);

  update public.reconciliation_alerts
     set status = 'RESOLVED', resolved_at = now()
   where reference = 'SWEEP-TEST-MISSING-1';

  select id into v_found
    from public.reconciliation_alerts
   where reference = 'SWEEP-TEST-MISSING-1'
     and alert_type = 'PROVIDER_COMPLETED_MISSING_LOCAL'
     and status = 'OPEN'
   limit 1;
  perform tc_test.ok('a resolved alert does not block a new one — the money is still uncredited',
    v_found is null);

  perform tc_test.eq_num('the resolved alert is kept, not deleted',
    (select count(*)::int from public.reconciliation_alerts
      where reference = 'SWEEP-TEST-MISSING-1'), 1);

  select count(*)::int into v_count
    from public.reconciliation_alerts
   where reference like 'SWEEP-TEST-%';
  perform tc_test.eq_num('exactly the three fixtures exist', v_count, 3);
end $$;


/* -- cleanup ---------------------------------------------------------------- */

delete from public.reconciliation_alerts where reference like 'SWEEP-TEST-%';

do $$
begin
  perform tc_test.eq_num('the fixtures are removed so the suite leaves nothing behind',
    (select count(*)::int from public.reconciliation_alerts
      where reference like 'SWEEP-TEST-%'), 0);
end $$;
