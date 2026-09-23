-- ============================================================================
-- 0025 — redeem_code credits a PROFILE, not an auth user id
--
-- HOW THIS WAS FOUND
-- ------------------
-- Fixing /api/redeem to use the caller's client instead of the service-role one
-- made auth.uid() resolve — and then the redemption still could not work, for a
-- second and independent reason.
--
-- redeem_code opens with:
--
--     v_user_id := auth.uid();
--
-- and passes that value to public.wallet_post(p_user_id => v_user_id) and to
-- public.notify_user(v_user_id, …). Both of those are keyed by a PUBLIC PROFILE
-- id, not an auth user id:
--
--   * wallets.user_id        → public.profiles(id)
--     wallet_post does `select * into v_wallet from public.wallets where
--     user_id = p_user_id for update` and raises WALLET_NOT_FOUND when nothing
--     matches. An auth id matches nothing.
--   * notifications.user_id  → public.profiles(id), a foreign key. An auth id
--     that is not also a profile id violates it.
--
-- auth.uid() returns an auth.users id. public.profiles carries `auth_user_id` as
-- a SEPARATE column, and it is never equal to `id` — verified against the live
-- project before this migration was written:
--
--     profiles                   410
--     id = auth_user_id            0
--     id <> auth_user_id         410
--     wallets keyed by profile id 410
--     wallets keyed by auth id      0
--
-- So the function could never have credited anyone: with a correct identity it
-- fails at the wallet lookup, and with the service-role client it failed one step
-- earlier at the auth.uid() guard. The two faults sat on the same line of
-- reasoning, which is why neither was ever seen — there is no test anywhere in
-- this repository that calls redeem_code, and no redeem code has ever been
-- created, so no path ever reached it in production.
--
-- WHAT THIS CHANGES
-- -----------------
-- The identity is resolved ONCE, from auth.uid(), into a profile id, and every
-- downstream call takes that profile id. The ledger reference is keyed the same
-- way as every other movement — by profile — so the idempotency check, the
-- advisory lock and the replay refusal all keep meaning what they meant.
--
-- Nothing else moves: the code lookup, expiry check, redemption cap, counter
-- increment and response shape are unchanged, because they were already right.
--
-- WHY anon IS REVOKED
-- -------------------
-- The grant is narrowed to `authenticated` here. An anonymous caller has no
-- auth.uid() at all, so every call from that role could only ever raise
-- UNAUTHORIZED — the privilege bought nothing and widened the client-executable
-- surface for no reason. This keeps redeem_code on 0024's intentional allowlist
-- (a signed-in user redeeming a code for their own wallet is the design) while
-- removing the role for which the function cannot work.
-- ============================================================================

create or replace function public.redeem_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  /*
    Two ids, deliberately distinct. `auth.uid()` identifies the AUTH user;
    the wallet, the ledger and the notification are all keyed by the PROFILE.
    Conflating them is what broke this function.
  */
  v_auth_user_id uuid;
  v_user_id      uuid;
  v_code         public.redeem_codes;
  v_tx           public.wallet_transactions;
begin
  v_auth_user_id := auth.uid();
  if v_auth_user_id is null then
    raise exception 'UNAUTHORIZED' using errcode = '28000';
  end if;

  select p.id into v_user_id
    from public.profiles p
   where p.auth_user_id = v_auth_user_id;

  /*
    The profile is created by the on_auth_user_created trigger, so this is the
    "auth user exists but was never provisioned" case rather than a normal one.
    It is named separately instead of falling through to WALLET_NOT_FOUND, which
    would be true but would point at the wallet when the missing thing is the
    profile.
  */
  if v_user_id is null then
    raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Advisory lock: one redeem at a time per code string.
  perform pg_advisory_xact_lock(hashtext('redeem:' || upper(trim(p_code))));

  select * into v_code from public.redeem_codes
   where code = upper(trim(p_code))
     and status = 'ACTIVE'
   for update;

  if not found then
    raise exception 'REDEEM_CODE_INVALID' using errcode = 'P0001';
  end if;

  if v_code.expires_at is not null and v_code.expires_at < now() then
    update public.redeem_codes set status = 'EXPIRED' where id = v_code.id;
    raise exception 'REDEEM_CODE_EXPIRED' using errcode = 'P0001';
  end if;

  if v_code.redemptions_used >= v_code.max_redemptions then
    raise exception 'REDEEM_CODE_EXHAUSTED' using errcode = 'P0001';
  end if;

  -- Idempotent: check if this user already redeemed this exact code.
  if exists (
    select 1 from public.wallet_transactions
     where reference = 'REDEEM-' || v_code.id::text || '-' || v_user_id::text
  ) then
    raise exception 'REDEEM_ALREADY_USED' using errcode = 'P0001';
  end if;

  -- Credit the caller's own wallet, keyed by the profile.
  v_tx := public.wallet_post(
    p_user_id     => v_user_id,
    p_type        => 'REFUND',
    p_amount      => v_code.amount,
    p_status      => 'COMPLETED',
    p_reference   => 'REDEEM-' || v_code.id::text || '-' || v_user_id::text,
    p_description => 'Redeem code: ' || v_code.code,
    p_metadata    => jsonb_build_object('redeem_code_id', v_code.id, 'code', v_code.code),
    p_source      => 'SYSTEM'
  );

  -- Increment redemption counter.
  update public.redeem_codes
     set redemptions_used = redemptions_used + 1,
         status = case
           when redemptions_used + 1 >= max_redemptions then 'EXPIRED'
           else status
         end
   where id = v_code.id;

  perform public.notify_user(
    v_user_id, 'REDEEM_COMPLETED',
    'Code redeemed!',
    'KES ' || to_char(v_code.amount, 'FM999,999,990.00') || ' has been added to your wallet.',
    'SUCCESS', '/dashboard/wallet'
  );

  return jsonb_build_object(
    'success', true,
    'amount', v_code.amount,
    'currency', v_code.currency,
    'remaining', v_code.max_redemptions - v_code.redemptions_used - 1
  );
end;
$fn$;

/*
  `create or replace` on the same signature preserves the existing ACL, so the
  grants are restated rather than assumed. Stating them also makes the narrow
  anon revoke below explicit instead of inherited from whatever the last
  definition happened to leave behind.
*/
revoke all on function public.redeem_code(text) from public, anon;
grant execute on function public.redeem_code(text) to authenticated, service_role;


-- ============================================================================
-- Verification — privileges asserted, then the behaviour proved.
-- ============================================================================

do $mig$
begin
  if has_function_privilege('anon', 'public.redeem_code(text)', 'EXECUTE') then
    raise exception '0025: anon can still execute redeem_code, which has no auth identity to act as';
  end if;

  if not has_function_privilege('authenticated', 'public.redeem_code(text)', 'EXECUTE') then
    raise exception
      '0025: authenticated lost EXECUTE on redeem_code — no signed-in user could redeem a code';
  end if;

  if not has_function_privilege('service_role', 'public.redeem_code(text)', 'EXECUTE') then
    raise exception '0025: service_role lost EXECUTE on redeem_code';
  end if;
end
$mig$;

/*
  The behavioural check, in the shape 0022 established: drive the real function
  as a real caller and then throw the work away.

  A privilege assertion cannot tell whether the credit lands on the RIGHT wallet,
  and that is the whole of this bug — the old function was perfectly privileged
  and still could not credit anyone. So this runs a genuine redemption against an
  existing account, asserts the balance moved by exactly the code amount and that
  exactly one ledger row was written under that PROFILE, and then raises from
  inside the block so the subtransaction rolls back. Nothing it does survives.

  If no profile with a wallet exists yet, it says so and skips rather than
  inventing one: a self-check must not be the thing that creates production rows.
*/
do $mig$
declare
  v_auth      uuid;
  v_profile   uuid;
  v_code_id   uuid;
  v_code      text := '0025-SELFCHECK-' || upper(substr(gen_random_uuid()::text, 1, 8));
  v_amount    numeric := 25;
  v_before    numeric;
  v_after     numeric;
  v_rows      int;
begin
  select p.id, p.auth_user_id
    into v_profile, v_auth
    from public.profiles p
    join public.wallets w on w.user_id = p.id
   where p.status = 'ACTIVE'
   order by p.created_at
   limit 1;

  if v_profile is null then
    raise notice '0025: no ACTIVE profile with a wallet yet — behavioural self-check skipped';
    return;
  end if;

  begin
    insert into public.redeem_codes (code, amount, currency, max_redemptions, status)
    values (v_code, v_amount, 'KES', 1, 'ACTIVE')
    returning id into v_code_id;

    -- The only thing that identifies the caller, exactly as PostgREST supplies it.
    perform set_config('request.jwt.claim.sub', v_auth::text, true);

    select available_balance into v_before from public.wallets where user_id = v_profile;
    perform public.redeem_code(v_code);
    select available_balance into v_after from public.wallets where user_id = v_profile;

    if v_after - v_before <> v_amount then
      raise exception
        '0025 self-check: a redemption moved % instead of % — the credit did not land on the caller''s wallet',
        v_after - v_before, v_amount;
    end if;

    select count(*) into v_rows
      from public.wallet_transactions
     where user_id = v_profile
       and reference like 'REDEEM-' || v_code_id::text || '-%';

    if v_rows <> 1 then
      raise exception
        '0025 self-check: expected exactly 1 ledger row keyed to the profile, found %', v_rows;
    end if;

    -- Everything above is discarded by the subtransaction rolling back.
    raise exception '0025 self-check passed; unwinding the probe'
      using errcode = 'P0001';
  exception
    when others then
      if position('0025 self-check passed' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  raise notice '0025: redeem_code credits the caller''s profile wallet, exactly once (probe rolled back)';
end
$mig$;
