-- ============================================================================
-- 0023 — Lock the money functions by NAME, not by signature
--
-- WHY THIS IS A SECURITY FIX AND NOT A TIDY-UP
-- --------------------------------------------
-- 0004 revoked client EXECUTE on an explicit allowlist of money functions,
-- naming each one with its full argument list:
--
--     revoke all on function public.deposit_credit(text,text,jsonb) ...
--     grant  execute on function public.deposit_credit(text,text,jsonb) to service_role;
--
-- 0015 then redefined deposit_credit with FIVE parameters instead of three.
-- `create or replace function` identifies a function by its name AND its
-- argument list, so that was not a replacement — Postgres created a second
-- function beside the first and gave it the default privilege, which is
-- `EXECUTE` granted to `PUBLIC`. Everything under PUBLIC includes `anon` and
-- `authenticated`. Nothing ever revoked it.
--
-- 0021 dropped the three-argument function, so from that migration onward the
-- ONLY deposit_credit that exists is the one clients can execute:
--
--     select has_function_privilege('anon','public.deposit_credit(text,text,text,numeric,jsonb)','EXECUTE');
--     -- true, verified against the live project before this migration was written
--
-- IT IS NOT A READ-ONLY FUNCTION
-- ------------------------------
-- deposit_credit is `security definer` and posts a wallet transaction. It does
-- NOT ask the provider whether the money arrived — that check lives in the
-- application, in verifyAndSettleDeposit(). PostgREST exposes any function in
-- the `public` schema that the requesting role may execute, so a signed-in user
-- holding a PENDING deposit could read their own merchant_reference (RLS permits
-- reading your own deposits) and call the RPC directly to credit the wallet
-- without paying, then request a withdrawal. The grant was the only thing
-- standing in the way, and it was absent.
--
-- WHY BY NAME THIS TIME
-- ---------------------
-- Revoking the exact signature again would fix today's symptom and leave the
-- same trap for the next redefinition — which is precisely how this happened.
-- This revision revokes every overload of each money function by iterating the
-- catalog, so a future `create or replace` with a different argument list is
-- covered the moment it is created, without anyone remembering this file.
--
-- WHY service_role KEEPS IT
-- -------------------------
-- The application credits deposits through the service-role client:
-- `admin.rpc("deposit_credit", …)` in src/server/services/deposits.ts, where
-- `admin` is createAdminSupabaseClient(). Revoking from anon/authenticated does
-- not touch that path. Internal DB callers are unaffected too: a `security
-- definer` function executes as its owner, not as the requestor.
-- ============================================================================

do $$
declare
  fn_name    text;
  target     record;
  locked     int := 0;

  /*
    The money-critical functions 0004 intended to be service-role only. These are
    the names whose privilege must not depend on an argument list staying still.
  */
  fn_names text[] := array[
    'wallet_post',
    'deposit_credit',
    'deposit_fail',
    'withdrawal_reserve',
    'withdrawal_release',
    'withdrawal_complete',
    'admin_adjust_wallet',
    'video_start',
    'video_progress',
    'video_complete_session',
    'referral_qualify',
    'referral_credit',
    'referral_commission_on_deposit',
    'notify_user',
    'write_audit',
    'record_fraud_event',
    'rate_limit_hit',
    'claim_idempotency_key',
    'ensure_profile'
  ];
begin
  foreach fn_name in array fn_names loop
    for target in
      select p.oid,
             pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname = fn_name
    loop
      /*
        Role names are written literally rather than interpolated: they are fixed
        keywords, and quoting them would turn `public` into an identifier that
        does not exist.
      */
      execute format(
        'revoke all on function public.%I(%s) from public, anon, authenticated',
        fn_name, target.args
      );
      execute format(
        'grant execute on function public.%I(%s) to service_role',
        fn_name, target.args
      );
      locked := locked + 1;
    end loop;
  end loop;

  raise notice '0023: locked % money function overload(s) to service_role', locked;
end $$;


-- ============================================================================
-- Verification — asserted, not described.
--
-- Both halves are checked: that clients CANNOT execute deposit_credit, and that
-- service_role still CAN. The second is not decoration. A migration that locks
-- the function down and also locks the application out would stop every deposit
-- from being credited — which is the same outage 0021 was written to end, and it
-- would be silent until the next real deposit.
-- ============================================================================

do $$
declare
  exposed text[];
begin
  select coalesce(
           array_agg(distinct p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'),
           '{}'
         )
    into exposed
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'deposit_credit'
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE'));

  if array_length(exposed, 1) is not null then
    raise exception
      'client roles can still execute deposit_credit: % — a signed-in user could credit a deposit without paying',
      array_to_string(exposed, ', ');
  end if;

  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'deposit_credit'
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception
      'service_role lost EXECUTE on deposit_credit — the application settles deposits with the service-role client and would stop crediting them';
  end if;

  raise notice '0023: deposit_credit is client-inaccessible and service-role usable';
end $$;
