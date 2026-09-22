-- ============================================================================
-- 0021 — Drop the obsolete 3-argument overload of deposit_credit
--
-- WHY THIS IS URGENT AND NOT A TIDY-UP
-- ------------------------------------
-- 0002 defined:
--
--   deposit_credit(p_merchant_reference text, p_provider_transaction_id text,
--                  p_payload jsonb)
--
-- 0015 redefined it with a DIFFERENT parameter list, adding p_provider_reference
-- and p_amount:
--
--   deposit_credit(p_merchant_reference text, p_provider_transaction_id text,
--                  p_provider_reference text default null,
--                  p_amount numeric default null,
--                  p_payload jsonb default null)
--
-- `create or replace function` identifies a function by its NAME and ARGUMENT
-- LIST. Because the list changed, 0015 did not replace anything — Postgres kept
-- the 0002 function and added a second one beside it. No migration ever dropped
-- the original, so the database has carried both ever since.
--
-- The caller is what turns that into an outage. `createDeposit`'s verification
-- step calls the function with exactly three arguments:
--
--   p_merchant_reference, p_provider_transaction_id, p_payload
--
-- Both candidates accept that call — the 3-argument one matches it exactly, and
-- the 5-argument one matches because its two extra parameters are defaulted — so
-- PostgREST cannot pick one and refuses the request:
--
--   PGRST203  Could not choose the best candidate function between:
--     public.deposit_credit(...jsonb)
--     public.deposit_credit(...text, numeric, jsonb)
--
-- HTTP 300, on every deposit. A deposit could be created and an STK request
-- could be sent, but no callback and no later verification could ever credit it,
-- because the function that does the crediting could not be resolved. Every
-- deposit credit in the platform was failing at this one call.
--
-- WHAT IS KEPT
-- ------------
-- The 5-argument version is the correct survivor: it carries 0015's deposit-bonus
-- logic, and because its added parameters are all defaulted a three-argument call
-- resolves to it cleanly once the ambiguity is gone. Dropping the newer one
-- instead would silently discard the bonus behaviour, so the direction matters.
--
-- It is safe to drop: nothing in the codebase calls the 3-argument version by
-- name, and no SQL object depends on it — the two are independent definitions,
-- not a wrapper and its implementation.
-- ============================================================================

drop function if exists public.deposit_credit(text, text, jsonb);


-- ============================================================================
-- Verification: exactly one deposit_credit must remain, with five arguments.
--
-- Left as an assertion rather than a comment, because the failure it guards
-- against — a third overload appearing later — is silent until a deposit is
-- attempted, and this runs at migration time instead.
-- ============================================================================

do $$
declare
  v_count int;
  v_args  text;
begin
  select count(*), string_agg(pg_get_function_identity_arguments(p.oid), ' | ')
    into v_count, v_args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'deposit_credit';

  if v_count <> 1 then
    raise exception
      'expected exactly one public.deposit_credit, found % — a 3-argument call would be ambiguous again (%)',
      v_count, coalesce(v_args, 'none');
  end if;

  if v_args not like '%p_provider_transaction_id text%'
     or v_args not like '%p_provider_reference text%' then
    raise exception 'public.deposit_credit survived with an unexpected signature: %', v_args;
  end if;

  raise notice 'deposit_credit resolved: %', v_args;
end $$;
