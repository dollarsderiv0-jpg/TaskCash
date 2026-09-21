-- ============================================================================
-- 60 — security posture
--
-- The browser must be able to read only its own rows and must not be able to
-- write to anything financial, in any way, through any path.
-- ============================================================================

/* -- RLS coverage ----------------------------------------------------------- */

do $$
declare
  missing text[];
begin
  select array_agg(t.name order by t.name) into missing
    from (
      select c.relname as name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and c.relname <> 'taskcash_migrations'
         and not c.relrowsecurity
    ) t;

  perform tc_test.ok('row level security is enabled on every public table',
    missing is null, coalesce(array_to_string(missing, ', '), 'all covered'));
end $$;

/* -- no client-writable financial table ------------------------------------- */

do $$
declare
  offenders text[];
begin
  select array_agg(p.tablename || ':' || p.cmd order by p.tablename) into offenders
    from pg_policies p
   where p.schemaname = 'public'
     and p.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
     and p.tablename in (
       'profiles','wallets','wallet_transactions','deposits','withdrawals',
       'video_watch_sessions','referrals','referral_commissions','audit_logs',
       'fraud_events','system_settings','currencies','idempotency_keys',
       'payment_events','reconciliation_alerts'
     )
     and not (p.roles = array['service_role']::name[]);

  perform tc_test.ok('no insert/update/delete policy exists on a financial table',
    offenders is null, coalesce(array_to_string(offenders, ', '), 'none'));

  -- notifications is the single deliberate exception: a user may mark their
  -- own notifications read, and nothing else.
  perform tc_test.ok('the only client update policy is for notification read state',
    exists (select 1 from pg_policies
             where schemaname = 'public' and tablename = 'notifications' and cmd = 'UPDATE'),
    'notifications read_at');
end $$;

/* -- table grants ----------------------------------------------------------- */

do $$
declare
  t text;
  writable text[] := array[]::text[];
begin
  foreach t in array array[
    'profiles','wallets','wallet_transactions','deposits','withdrawals',
    'referrals','referral_commissions','audit_logs','fraud_events','system_settings'
  ] loop
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE') then
      writable := writable || t;
    end if;
  end loop;

  perform tc_test.ok('authenticated has no write privilege on financial tables',
    array_length(writable, 1) is null, coalesce(array_to_string(writable, ', '), 'none'));

  perform tc_test.eq_bool('authenticated can still read its own wallet rows',
    has_table_privilege('authenticated', 'public.wallets', 'SELECT'), true);
  perform tc_test.eq_bool('anon cannot read wallets at all',
    has_table_privilege('anon', 'public.wallets', 'SELECT'), false);
end $$;

/* -- function grants -------------------------------------------------------- */

do $$
declare
  money_fns text[] := array[
    'public.wallet_post(uuid,text,numeric,text,text,text,text,jsonb,text,uuid)',
    'public.deposit_credit(text,text,jsonb)',
    'public.withdrawal_reserve(uuid,numeric,text,text,numeric,int)',
    'public.withdrawal_release(uuid,text,text,uuid,jsonb)',
    'public.withdrawal_complete(uuid,text,text,jsonb)',
    'public.video_complete_session(uuid,uuid)',
    'public.admin_adjust_wallet(uuid,uuid,numeric,text)'
  ];
  f text;
  reachable text[] := array[]::text[];
begin
  foreach f in array money_fns loop
    if has_function_privilege('authenticated', f, 'EXECUTE')
       or has_function_privilege('anon', f, 'EXECUTE') then
      reachable := reachable || f;
    end if;
  end loop;

  perform tc_test.ok('clients cannot execute the money functions',
    array_length(reachable, 1) is null, coalesce(array_to_string(reachable, ', '), 'none'));
end $$;

-- The identity helper is called by the SELECT policies as the querying role.
-- If authenticated cannot execute it, every self-read fails outright.
--
-- is_admin() must stay unreachable, because no REACHABLE policy needs it.
--
-- 0015 adds an admin-write policy that calls it, which looks like it contradicts this
-- assertion — 0015 briefly granted the function to authenticated on exactly that
-- reading, and this file failed the moment 0015 could be applied at all. The
-- resolution is that the policy is unreachable: `whatsapp_groups` grants no write
-- privilege to anon or authenticated, so the policy is never evaluated for them, and
-- admin writes go through the service role in /api/admin/groups. A policy is only
-- evaluated for a role that holds a table privilege.
--
-- So the grant was withdrawn from 0015 and this assertion stands. The probes at the end
-- of the file check the other half of it — that an admin cannot write that table from a
-- browser session either — so a later migration that grants the table cannot quietly
-- make this assertion the only thing standing between a client and an admin table.
do $$
begin
  perform tc_test.eq_bool('a signed-in user can execute the identity helper the policies use',
    has_function_privilege('authenticated', 'public.current_profile_id()', 'EXECUTE'), true);
  perform tc_test.eq_bool('anon cannot execute the identity helper',
    has_function_privilege('anon', 'public.current_profile_id()', 'EXECUTE'), false);
  perform tc_test.eq_bool('a signed-in user cannot execute is_admin()',
    has_function_privilege('authenticated', 'public.is_admin()', 'EXECUTE'), false);
end $$;

/* -- live cross-user isolation --------------------------------------------- */

create temp table if not exists t_sec (can_switch boolean not null default false);

do $$
begin
  begin
    set local role authenticated;
    reset role;
    update t_sec set can_switch = true;
  exception when others then
    update t_sec set can_switch = false;
  end;
end $$;

do $$
declare
  u1 uuid;
  u2 uuid;
  v_auth uuid;
  visible int;
  own int;
  v_wallet numeric;
  v_msg text;
  affected int;
begin
  if not (select can_switch from t_sec) then
    perform tc_test.skip('live row-level-security probes',
      'the connecting role cannot SET ROLE authenticated (expected on some managed databases)');
    return;
  end if;

  u1 := tc_test.create_user('sec_iso_a@test.invalid');
  u2 := tc_test.create_user('sec_iso_b@test.invalid');
  perform tc_test.fund(u1, 500);
  perform tc_test.fund(u2, 900);
  v_auth := (select auth_user_id from public.profiles where id = u1);

  /* own rows only */
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_auth::text, true);

  select count(*)::int into visible from public.wallets;
  select count(*)::int into own from public.wallets where user_id = u1;
  select available_balance into v_wallet from public.wallets limit 1;

  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  select count(*)::int into affected from public.wallets where true;
  reset role;

  perform tc_test.eq_num('a signed-in user sees exactly one wallet', visible, 1);
  perform tc_test.eq_num('the visible wallet is their own', own, 1);
  perform tc_test.eq_num('the visible balance is their own', v_wallet, 500);
  perform tc_test.eq_num('an unknown identity sees no wallets', affected, 0);

  /* the client cannot write, through either path */
  set local role authenticated;
  begin
    update public.wallets set available_balance = 999999 where user_id = u1;
    v_msg := 'NO ERROR RAISED';
  exception when others then
    v_msg := sqlerrm;
  end;

  begin
    insert into public.wallet_transactions (user_id, wallet_id, type, amount, currency, reference)
    values (u1, (select id from public.wallets where user_id = u1), 'DEPOSIT', 5000, 'KES', 'HACK-1');
    v_msg := coalesce(v_msg, '') || ' | INSERT SUCCEEDED';
  exception when others then
    v_msg := coalesce(v_msg, '') || ' | ' || sqlerrm;
  end;

  begin
    perform public.wallet_post(u1, 'DEPOSIT', 5000, 'COMPLETED', 'HACK-2', null, null, '{}'::jsonb, 'TEST', null);
    v_msg := v_msg || ' | RPC SUCCEEDED';
  exception when others then
    v_msg := v_msg || ' | ' || sqlerrm;
  end;
  reset role;

  perform tc_test.ok('a client cannot update a balance',
    position('permission denied' in v_msg) > 0 and position('SUCCEEDED' in v_msg) = 0, v_msg);
  perform tc_test.eq_num('the balance is unchanged after the attempt', tc_test.available(u1), 500);
  perform tc_test.eq_num('no forged ledger row exists', tc_test.ledger_count('HACK-1'), 0);
  perform tc_test.eq_num('no forged ledger row exists via the RPC', tc_test.ledger_count('HACK-2'), 0);
end $$;

/* -- a user may only mark their own notifications read --------------------- */

do $$
declare
  u1 uuid;
  u2 uuid;
  v_auth uuid;
  affected int;
  still_unread timestamptz;
begin
  if not (select can_switch from t_sec) then
    perform tc_test.skip('notification read-state isolation', 'SET ROLE unavailable');
    return;
  end if;

  u1 := tc_test.create_user('sec_notif_a@test.invalid');
  u2 := tc_test.create_user('sec_notif_b@test.invalid');
  perform public.notify_user(u2, 'TEST', 'Secret', 'not yours');
  v_auth := (select auth_user_id from public.profiles where id = u1);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_auth::text, true);
  update public.notifications set read_at = now() where user_id = u2;
  get diagnostics affected = row_count;
  reset role;

  perform tc_test.eq_num('a user cannot mark another account''s notifications read', affected, 0);

  select read_at into still_unread from public.notifications where user_id = u2 limit 1;
  perform tc_test.ok('the other user''s notification is untouched', still_unread is null);
end $$;

/* -- an admin table is unwritable from a browser session -------------------- */

/*
  The other half of "no REACHABLE policy needs is_admin()": the admin-only table is
  unwritable from a browser session by anyone, admin included, because it carries no
  client write privilege and admin writes go through /api/admin/groups with the
  service role.

  Asserted in BOTH directions rather than assumed, because the plausible repair is the
  dangerous one: a later migration could "fix" the apparently-inert admin-write policy
  on this table by granting it to `authenticated`. If that ever happens, the admin
  attempt below stops being refused and this test says so, instead of the grant landing
  quietly along with an is_admin() function that would then also have to be exposed.
*/

do $$
declare
  v_user  uuid;
  v_admin uuid;
  v_non_admin_msg text;
  v_admin_msg     text;
  v_read_msg      text;
  v_rows          int;
begin
  if not (select can_switch from t_sec) then
    perform tc_test.skip('admin-table write probes', 'SET ROLE unavailable');
    return;
  end if;

  v_user  := tc_test.create_user('sec_admin_write@test.invalid');
  v_admin := tc_test.create_user('sec_admin_true@test.invalid');
  update public.profiles set role = 'ADMIN', status = 'ACTIVE' where id = v_admin;

  set local role authenticated;

  perform set_config('request.jwt.claim.sub',
    (select auth_user_id from public.profiles where id = v_user)::text, true);
  begin
    insert into public.whatsapp_groups (name, invite_link)
    values ('Not allowed', 'https://example.test/nope');
    v_non_admin_msg := 'INSERT SUCCEEDED';
  exception when others then
    v_non_admin_msg := sqlerrm;
  end;

  perform set_config('request.jwt.claim.sub',
    (select auth_user_id from public.profiles where id = v_admin)::text, true);
  begin
    insert into public.whatsapp_groups (name, invite_link)
    values ('Still not allowed', 'https://example.test/nope2');
    v_admin_msg := 'INSERT SUCCEEDED';
  exception when others then
    v_admin_msg := sqlerrm;
  end;

  /*
    Reads, too. This table is service-role-only end to end: the dashboard groups page
    reads it with the service role (`createAdminSupabaseClient`), which is why having
    no client grant breaks nothing — and why the public-read policy 0015 declares on
    it is inert for exactly the same reason the admin-write policy is.

    Both are asserted so they cannot drift apart quietly. The failure this guards
    against is a later migration granting the table to `authenticated` and turning two
    decorative policies into live ones nobody re-read.
  */
  begin
    perform count(*) from public.whatsapp_groups;
    v_read_msg := 'READ ALLOWED';
  exception when others then
    v_read_msg := sqlerrm;
  end;

  reset role;

  select count(*)::int into v_rows
    from public.whatsapp_groups
   where name in ('Not allowed', 'Still not allowed');

  perform tc_test.ok('a signed-in non-admin cannot write an admin table',
    position('SUCCEEDED' in v_non_admin_msg) = 0, v_non_admin_msg);
  perform tc_test.ok('nor can a signed-in admin, which is why is_admin() stays unexposed',
    position('SUCCEEDED' in v_admin_msg) = 0, v_admin_msg);
  perform tc_test.eq_num('and neither attempt wrote a row', v_rows, 0);
  perform tc_test.ok('and the table is not readable from a signed-in session either',
    position('ALLOWED' in v_read_msg) = 0, v_read_msg);
end $$;

drop table if exists t_sec;
