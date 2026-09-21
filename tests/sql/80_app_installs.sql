-- ============================================================================
-- 80 — app installs (migration 0018)
--
--   record_app_install() stamps the profile ONCE and appends every report to the
--   trail, and no client can call it or read the trail.
--
-- These assertions exist because the wallet screen changes what it shows based on
-- this value: "the limits are visible" must not be something a browser can ask
-- for, and must not become visible by accident.
-- ============================================================================

/* -- recording -------------------------------------------------------------- */

do $$
declare
  u uuid := tc_test.create_user('app_install@test.invalid');
  first_at  timestamptz;
  second_at timestamptz;
begin
  perform tc_test.ok('an account starts with nothing recorded',
    (select app_downloaded_at is null from public.profiles where id = u));

  first_at := public.record_app_install(u, 'STANDALONE', 'test-agent/1');
  perform tc_test.ok('the first report stamps the profile', first_at is not null);
  perform tc_test.ok('and the stamp is a real instant',
    first_at <= now() and first_at > now() - interval '1 minute');

  second_at := public.record_app_install(u, 'MANUAL', 'test-agent/2');
  perform tc_test.eq_text('a later report does not move the stamp',
    second_at::text, first_at::text);

  perform tc_test.eq_num('every report is kept in the trail',
    (select count(*)::int from public.app_installs where user_id = u), 2);

  /*
    Asserted as a SET, not as "the first row": both inserts share the transaction's
    timestamp, so `order by created_at` is a tie and picking the earliest row would
    be asserting whatever the planner felt like returning.
  */
  perform tc_test.eq_num('the source of each report is kept',
    (select count(*)::int from public.app_installs
      where user_id = u and source = 'STANDALONE'), 1);

  /*
    An unrecognised source is stored as MANUAL rather than refused: this is a
    convenience record, not a gate, and losing the fact that the user really did
    install the app over a spelling mismatch would be the worse failure.
  */
  perform public.record_app_install(u, 'NOT_A_REAL_SOURCE', null);
  perform tc_test.eq_num('an unknown source is stored as MANUAL',
    (select count(*)::int from public.app_installs
      where user_id = u and source = 'MANUAL'), 2);

  perform tc_test.raises('an unknown profile is refused',
    format('select public.record_app_install(%L::uuid)', gen_random_uuid()),
    'PROFILE_NOT_FOUND');
end $$;


/* -- no client can manufacture or read an install --------------------------- */

create temp table if not exists t_app_sec (can_switch boolean not null default false);

do $$
begin
  begin
    set local role authenticated;
    reset role;
    update t_app_sec set can_switch = true;
  exception when others then
    update t_app_sec set can_switch = false;
  end;
end $$;

/*
  The probes run inside the authenticated role, where `tc_test.*` is not
  reachable, so each outcome is recorded into a flag and asserted after RESET ROLE.
  Asserting after the fact also keeps a raised error from escaping the role switch.
*/
do $$
declare
  u uuid := tc_test.create_user('app_install_sec@test.invalid');
  v_can_record boolean := true;
  v_can_read   boolean := true;
  v_can_stamp  boolean := true;
begin
  if not (select can_switch from t_app_sec) then
    perform tc_test.skip('app install privilege probes', 'SET ROLE unavailable');
    return;
  end if;

  set local role authenticated;

  begin
    perform public.record_app_install(u, 'MANUAL', null);
  exception when others then
    v_can_record := false;
  end;

  begin
    perform 1 from public.app_installs limit 1;
  exception when others then
    v_can_read := false;
  end;

  begin
    update public.profiles set app_downloaded_at = now() where id = u;
  exception when others then
    v_can_stamp := false;
  end;

  reset role;

  perform tc_test.ok('a signed-in client cannot record an install', not v_can_record);
  perform tc_test.ok('a signed-in client cannot read the install trail', not v_can_read);

  /*
    The decisive one. If a client can write the column directly, then "the limits
    are visible" is a property of the client's last request rather than of the
    account, and the whole record is decoration. Column privileges in 0018 are
    what stop it, so this assertion is the test of that grant.
  */
  perform tc_test.ok('a client cannot stamp its own profile directly',
    not v_can_stamp and (select app_downloaded_at is null from public.profiles where id = u));
end $$;

drop table if exists t_app_sec;
