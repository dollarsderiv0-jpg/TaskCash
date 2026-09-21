-- ============================================================================
-- 0012_deposit_provider_identifiers.sql
--
-- Make a settled M-Pesa payment reconcilable against Safaricom.
--
-- `deposits` already holds every amount, the state machine and the reference we
-- generated, and RLS lets a user read only their own row. What it did NOT hold
-- as a queryable column were the three facts an operator is actually asked for
-- when a customer disputes a payment — they existed only inside jsonb
-- (`deposits.callback_payload`, `payment_events.payload`), which is fine for
-- forensics and useless at a support desk:
--
--   merchant_request_id   Safaricom's id for the STK request. It is quoted
--                         *alongside* the checkout id in every Daraja support
--                         conversation, and we were discarding it after parsing.
--   result_code           Safaricom's own reason code (1032 cancelled by user,
--                         1 no funds, 1025 push refused, 0 success…).
--                         `failure_reason` is OUR sentence describing what we
--                         did; this is THEIR evidence for why. Without it,
--                         separating "the customer cancelled" from "our passkey
--                         is wrong" means opening a JSON blob by hand.
--   result_description    The matching provider text, stored unedited.
--
-- `checkout_request_id` and `mpesa_receipt_number` are GENERATED columns over
-- `provider_reference` and `provider_transaction_id`. Those values are already
-- stored — this exposes them under the names Daraja uses, with no second copy to
-- drift apart and nothing extra for application code to write. Postgres refuses
-- to assign to a generated column, which is precisely the guarantee wanted here:
-- the alias can never disagree with the record it is derived from.
--
-- Nothing here is financial. No balance, ledger row or status can be changed by
-- these columns, and they are written only by the server-side service using the
-- service-role client. Clients hold SELECT on their own deposit and nothing more
-- (see 0004_rls.sql, "deposits_select_own"); there is deliberately no INSERT,
-- UPDATE or DELETE policy for authenticated users.
--
-- Safe to re-run.
-- ============================================================================

alter table public.deposits
  add column if not exists merchant_request_id text,
  add column if not exists result_code         text,
  add column if not exists result_description  text,
  add column if not exists checkout_request_id text
    generated always as (provider_reference) stored,
  add column if not exists mpesa_receipt_number text
    generated always as (provider_transaction_id) stored,
  add column if not exists updated_at timestamptz not null default now();

-- Same maintenance pattern as every other mutable table (0001_schema.sql).
drop trigger if exists trg_deposits_updated on public.deposits;
create trigger trg_deposits_updated before update on public.deposits
  for each row execute function public.touch_updated_at();

-- Reconciliation looks a payment up by what Safaricom gave us, never by our own
-- reference: when a customer calls, the only ids they can quote are Safaricom's.
create index if not exists idx_deposits_merchant_request_id
  on public.deposits(merchant_request_id)
  where merchant_request_id is not null;

-- "Show me every deposit Safaricom refused, and why" — the query an operator
-- runs after a failed deployment.
create index if not exists idx_deposits_result_code
  on public.deposits(result_code)
  where result_code is not null;

comment on column public.deposits.merchant_request_id is
  'Safaricom MerchantRequestID from the STK Push response. Support/reconciliation only; never client-supplied.';
comment on column public.deposits.result_code is
  'Daraja ResultCode / ResponseCode exactly as Safaricom returned it. Written server-side only.';
comment on column public.deposits.result_description is
  'Daraja ResultDesc / ResponseDescription as returned. Unedited provider text.';
comment on column public.deposits.checkout_request_id is
  'Daraja CheckoutRequestID — generated from provider_reference so the two cannot drift.';
comment on column public.deposits.mpesa_receipt_number is
  'M-Pesa receipt number — generated from provider_transaction_id so the two cannot drift.';
