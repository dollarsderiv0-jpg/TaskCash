-- ============================================================================
-- 0024 — Lock the wallet-crediting functions 0023's list did not name
--
-- HOW THIS WAS FOUND
-- ------------------
-- 0023 locked nineteen money functions by name, every overload, and verified it
-- against the live project. This revision came out of asking a WIDER question
-- than the name list could answer:
--
--     "which SECURITY DEFINER functions can a client still execute whose body
--      writes to the wallet at all?"
--
-- That question is deliberately not limited to a list, because a list only ever
-- protects the names somebody remembered. Run against production it returned
-- four functions — and two of them credit a wallet:
--
--   public.apply_deposit_bonus(p_user_id uuid, p_amount numeric,
--                              p_currency text, p_deposit_id uuid)
--   public.referral_commission_on_purchase(p_referred_user_id uuid,
--                                          p_purchase_id uuid, p_price numeric,
--                                          p_currency text)
--
-- Both were reachable with EXECUTE by `anon` and `authenticated`.
--
-- WHY apply_deposit_bonus IS THE WORSE OF THE TWO
-- ----------------------------------------------
-- It takes the beneficiary AND the qualifying amount from the CALLER and posts
-- to that wallet through public.wallet_post with status COMPLETED. It is not a
-- lookup and it is not bounded by anything the caller cannot supply:
--
--   * p_user_id is the credited account, chosen by the caller — so a wallet
--     that is not theirs can be credited.
--   * p_amount only selects a tier, and the tiers are keyed on increasing `min`,
--     so a large p_amount reaches the highest bonus in the table.
--   * the reference it builds is
--     `DEPBONUS-<deposit_id>-<epoch seconds>`, which changes every second, so
--     repeating the call posts a fresh credit each time rather than being
--     deduplicated by a unique reference.
--
-- Its only intended caller is public.deposit_credit, which owns the deposit and
-- already knows the real amount (0015 and 0022 both call it internally, from
-- inside a SECURITY DEFINER function — so it runs as the owner and is unaffected
-- by revoking the client grant). No application code calls it directly.
--
-- referral_commission_on_purchase has no caller in src/ or in any migration: it
-- is dead code that credits a flat KES 50 to a `QUALIFIED` referrer, keyed on a
-- purchase id the caller supplies — so repeated calls with fresh ids would post
-- KES 50 each.
--
-- WHAT IS *NOT* CHANGED, AND WHY THAT MATTERS
-- ------------------------------------------
-- public.redeem_code(p_code text) is also client-executable and also credits a
-- wallet, and it is left alone ON PURPOSE. It reads its beneficiary from
-- auth.uid() rather than from an argument, takes its amount from the
-- admin-created code row, refuses a code that user already redeemed, and takes
-- an advisory lock so two concurrent redemptions cannot both pass. That is a
-- function designed to be called by a signed-in user for their own wallet, so
-- the client grant is the intended design rather than the defect. It is the one
-- entry in the allowlist below, and it is why the assertion at the end cannot
-- simply forbid every client-executable function that touches a wallet.
--
-- The third function the scan returned, referral_earning_on_video_reward(), is
-- a TRIGGER function (attached to trg_referral_earning on wallet_transactions).
-- A trigger fires as the table's owner and does not consult the requestor's
-- EXECUTE privilege, so revoking it costs nothing — it is included only so the
-- grant is not left standing as a curiosity.
--
-- Set this beside 0023: together they are the name-list pass and the
-- behaviour-based pass. Neither is sufficient alone, and the assertion below is
-- the part that will keep being true.
-- ============================================================================

do $mig$
declare
  fn_name text;
  target  record;
  locked  int := 0;

  fn_names text[] := array[
    'apply_deposit_bonus',
    'referral_commission_on_purchase',
    'referral_earning_on_video_reward'
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

  raise notice '0024: locked % additional money function overload(s) to service_role', locked;
end
$mig$;


-- ============================================================================
-- Verification — the general question, asked the way that found these.
--
-- The assertion is behavioural rather than name-based: it walks every
-- SECURITY DEFINER function in `public` whose body writes through wallet_post
-- or touches wallet_transactions, and fails if a client role can execute one
-- that is not on the intentional allowlist. A future function that credits a
-- wallet and forgets its grant therefore fails THIS MIGRATION at apply time,
-- instead of sitting exposed until someone thinks to search for it.
-- ============================================================================

do $mig$
declare
  allowed    text[] := array['redeem_code'];
  exposed    text[];
begin
  select coalesce(
           array_agg(distinct p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'),
           '{}'
         )
    into exposed
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and p.prokind = 'f'
     and pg_get_functiondef(p.oid) ~ '(wallet_post|wallet_transactions)'
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     and not (p.proname = any (allowed));

  if array_length(exposed, 1) is not null then
    raise exception
      'client roles can still execute wallet-writing function(s): % — add each to this migration''s lock list, or to the allowlist with a reason if the client grant is intended',
      array_to_string(exposed, ', ');
  end if;

  -- The two functions this migration exists for, asserted directly. The
  -- behavioural check above could pass while these were still exposed if the
  -- regex ever stopped matching them, so the specific claim is pinned too.
  select coalesce(
           array_agg(distinct p.proname),
           '{}'
         )
    into exposed
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('apply_deposit_bonus', 'referral_commission_on_purchase')
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE'));

  if array_length(exposed, 1) is not null then
    raise exception 'client roles can still execute: %', array_to_string(exposed, ', ');
  end if;

  -- And that the application can still credit a deposit bonus, which is the
  -- purpose of the grant being there in the first place. A migration that locks
  -- a function down and also locks the caller out is the silent outage 0021 and
  -- 0022 were written to end.
  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'apply_deposit_bonus'
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception
      'service_role lost EXECUTE on apply_deposit_bonus — deposit settlement calls it, so no deposit would be confirmed';
  end if;

  raise notice '0024: no client-executable wallet-writing function remains outside the allowlist';
end
$mig$;
