-- ============================================================================
-- 0015 — Deposit bonus tiers, referral commission on package purchase,
--        redeem codes, WhatsApp groups
-- ============================================================================

-- Deposit bonus tier configuration
/*
  One tier, as the operator specified: any deposit of 5,000 or more is credited
  1,000, every time.

  The tiers this replaces escalated with the deposit, and one of them was
  {min: 15000, bonus: 25000} — a deposit of 15,000 was to be credited a bonus of
  25,000, i.e. more money than the deposit that earned it, funded by nothing. A
  bonus larger than its own threshold is not a promotion the platform can pay out
  of the inflow it just received, so it is gone rather than merely renamed.

  `on conflict do update` means re-applying this file resets the tiers to this
  one. That is deliberate for a default, and it is why an operator who wants a
  different schedule should edit it here and regenerate the bundle rather than
  only in the settings screen.
*/
insert into public.system_settings (key, value, type, category, description, is_public)
values
  ('deposit_bonus.tiers', '[
    {"min": 5000, "bonus": 1000}
  ]'::jsonb, 'json', 'deposits',
  'Deposit bonus tiers: [{min, bonus}] in descending min order. First match wins.',
  true)
on conflict (key) do update set value = excluded.value;

-- ── 1. DEPOSIT BONUS TIERS ──────────────────────────────────────────────────
-- When a deposit settles, if the amount meets a bonus threshold, the user
-- receives an extra credit. The bonus is posted as a separate ledger row so
-- the original deposit amount is never distorted and the balance always
-- decomposes into clean, auditable movements.

-- Bonus tiers are stored in system_settings for easy admin control:
--   deposit_bonus.tiers = [ {min: 5000, bonus: 1000} ]
-- Evaluated in descending order of `min`; first match wins, and a deposit below
-- every threshold gets nothing.

create or replace function public.apply_deposit_bonus(
  p_user_id    uuid,
  p_amount     numeric,
  p_currency   text,
  p_deposit_id uuid
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tiers   jsonb;
  v_bonus   numeric := 0;
  v_entry   jsonb;
  v_tx      public.wallet_transactions;
begin
  v_tiers := public.setting_json('deposit_bonus.tiers', '[]'::jsonb);

  /*
    Walk tiers in descending min-amount order; first match wins.

    `jsonb_array_elements(...) as entry(value)` is named, and the ORDER BY reads
    `entry.value`. The previous version ordered by `(t->>'min')` against a set
    with no alias `t`, which is not a syntax error at migration time — the body is
    only planned when the loop is reached — so it applied cleanly and then raised
    `42703 column "t" does not exist` on every settlement. Since deposit
    settlement CALLS this function, that did not merely lose the bonus: it failed
    the confirmation of every deposit, bonus or not. Verified against a local
    Postgres before and after (`.freebuff/deposit-bonus-check.mjs`).
  */
  for v_entry in
    select entry.value
      from jsonb_array_elements(v_tiers) as entry(value)
     order by (entry.value ->> 'min')::numeric desc
  loop
    /*
      A tier missing either key is skipped rather than allowed to raise. This
      runs inside deposit settlement, so a malformed setting must not be able to
      stop a real deposit from being confirmed — an operator typo would otherwise
      take payments down.
    */
    if not (jsonb_exists(v_entry, 'min') and jsonb_exists(v_entry, 'bonus')) then
      continue;
    end if;

    if p_amount >= (v_entry->>'min')::numeric then
      v_bonus := (v_entry->>'bonus')::numeric;
      exit;
    end if;
  end loop;

  if v_bonus <= 0 then
    return 0;
  end if;

  v_tx := public.wallet_post(
    p_user_id     => p_user_id,
    p_type        => 'REFUND',
    p_amount      => v_bonus,
    p_status      => 'COMPLETED',
    p_reference   => 'DEPBONUS-' || p_deposit_id::text || '-' || to_char(extract(epoch from now()), 'FM999999999'),
    p_description => 'Deposit bonus — KES ' || to_char(v_bonus, 'FM999,999,990.00'),
    p_metadata    => jsonb_build_object('deposit_id', p_deposit_id, 'deposit_amount', p_amount, 'bonus_amount', v_bonus),
    p_source      => 'SYSTEM'
  );

  perform public.notify_user(
    p_user_id, 'DEPOSIT_BONUS',
    'Bonus added!',
    'You received a KES ' || to_char(v_bonus, 'FM999,999,990.00') || ' bonus for your deposit of KES ' || to_char(p_amount, 'FM999,999,990.00') || '!',
    'SUCCESS', '/dashboard/wallet'
  );

  return v_bonus;
end;
$$;


-- ── 2. REFERRAL COMMISSION ON PACKAGE PURCHASE ──────────────────────────────
-- When a referred user buys a package, the referrer gets:
--   · KES 50 flat commission
--   · 2 % of the referred user's TOTAL earnings from that package (ongoing)
-- The flat commission is credited immediately. The 2% is credited on each
-- package earning via the package_earn trigger below.

create or replace function public.referral_commission_on_purchase(
  p_referred_user_id uuid,
  p_purchase_id      uuid,
  p_price            numeric,
  p_currency         text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref     public.referrals;
  v_flat    numeric := 50;
  v_tx      public.wallet_transactions;
begin
  if not public.setting_bool('referrals.enabled', true) then
    return;
  end if;

  select * into v_ref from public.referrals
   where referred_user_id = p_referred_user_id and status = 'QUALIFIED';
  if not found then
    return;
  end if;

  -- Flat KES 50 commission on purchase
  v_tx := public.wallet_post(
    p_user_id     => v_ref.referrer_id,
    p_type        => 'REFERRAL_REWARD',
    p_amount      => v_flat,
    p_status      => 'COMPLETED',
    p_reference   => 'REF-PURCHASE-' || p_purchase_id::text,
    p_description => 'Referral commission for package purchase',
    p_metadata    => jsonb_build_object(
      'referred_user_id', p_referred_user_id,
      'purchase_id', p_purchase_id,
      'purchase_price', p_price,
      'commission_type', 'PACKAGE_PURCHASE_FLAT'
    ),
    p_source      => 'REFERRAL'
  );

  perform public.notify_user(
    v_ref.referrer_id, 'REFERRAL_COMMISSION',
    'Referral reward!',
    'You earned KES ' || to_char(v_flat, 'FM999,999,990.00') || ' for inviting a friend who purchased a package.',
    'SUCCESS', '/dashboard/referrals'
  );
end;
$$;


-- ── 3. ONGOING 2% EARNING COMMISSION ────────────────────────────────────────
-- Trigger function: after each package VIDEO_REWARD, credit the referrer 2%.
-- Deduplicated by reference (the ledger's idempotency).

create or replace function public.referral_earning_on_video_reward()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref       public.referrals;
  v_rate      numeric := 0.02;
  v_commission numeric;
  v_tx        public.wallet_transactions;
begin
  if not public.setting_bool('referrals.enabled', true) then
    return new;
  end if;

  select * into v_ref from public.referrals
   where referred_user_id = new.user_id and status = 'QUALIFIED';
  if not found then
    return new;
  end if;

  v_commission := round(new.amount * v_rate, 2);
  if v_commission <= 0 then
    return new;
  end if;

  v_tx := public.wallet_post(
    p_user_id     => v_ref.referrer_id,
    p_type        => 'REFERRAL_REWARD',
    p_amount      => v_commission,
    p_status      => 'COMPLETED',
    p_reference   => 'REF-EARN-' || new.id::text,
    p_description => 'Referral earning commission (2%)',
    p_metadata    => jsonb_build_object(
      'referred_user_id', new.user_id,
      'source_tx_id', new.id,
      'source_amount', new.amount,
      'commission_rate', v_rate,
      'commission_type', 'PACKAGE_EARNING_PERCENT'
    ),
    p_source      => 'REFERRAL'
  );

  return new;
end;
$$;

-- Fire only on VIDEO_REWARD (the earning type from package-gated watches)
drop trigger if exists trg_referral_earning on public.wallet_transactions;
create trigger trg_referral_earning
  after insert on public.wallet_transactions
  for each row
  when (new.type = 'VIDEO_REWARD' and new.status = 'COMPLETED')
  execute function public.referral_earning_on_video_reward();


-- ── 4. REDEEM CODES ────────────────────────────────────────────────────────
-- Admins generate random codes that carry a monetary value.
-- Each code can be redeemed by up to N users (default 5) and expires after
-- a configurable period. First-come, first-served.

create table if not exists public.redeem_codes (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  amount        numeric(20,4) not null check (amount > 0),
  currency      text not null default 'KES',
  max_redemptions integer not null default 5 check (max_redemptions > 0),
  redemptions_used integer not null default 0 check (redemptions_used >= 0),
  expires_at    timestamptz,
  created_by    uuid references auth.users(id),
  status        text not null default 'ACTIVE' check (status in ('ACTIVE','EXPIRED','DISABLED')),
  created_at    timestamptz not null default now()
);

create index if not exists idx_redeem_codes_code on public.redeem_codes (code);
create index if not exists idx_redeem_codes_status on public.redeem_codes (status) where status = 'ACTIVE';

alter table public.redeem_codes enable row level security;

-- Nobody reads redeem codes through the client. All access is server-side.
create policy "redeem_codes_no_public_read"
  on public.redeem_codes for all
  using (false)
  with check (false);


-- RPC: redeem a code. Deduplicates by (user_id, code) via advisory lock.
create or replace function public.redeem_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid;
  v_code     public.redeem_codes;
  v_tx       public.wallet_transactions;
  v_result   jsonb;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'UNAUTHORIZED' using errcode = '28000';
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

  -- Credit the user's wallet.
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
$$;


-- ── 5. WHATSAPP GROUPS ─────────────────────────────────────────────────────
-- Admin manages up to 10 WhatsApp groups. Users are auto-assigned based on
-- sign-up order (every 1000 users → next group).

create table if not exists public.whatsapp_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  invite_link text not null,
  sort_order  integer not null default 0,
  user_start  integer not null default 0,
  user_end    integer not null default 1000,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table public.whatsapp_groups enable row level security;

-- Public can read active groups (for display on dashboard).
create policy "whatsapp_groups_public_read"
  on public.whatsapp_groups for select
  using (is_active = true);

-- Only admin can write.
--
-- This originally read `exists (select 1 from public.profiles where id = auth.uid() and
-- is_admin = true)`, which was wrong twice over and failed the whole migration with
-- `column "is_admin" does not exist`:
--
--   * there is no `is_admin` COLUMN on profiles. 0004 defines `public.is_admin()` as a
--     function, precisely so the role rule lives in one place;
--   * `profiles.id` is the profile's own key — the auth mapping is `auth_user_id` — so
--     even with such a column the comparison would have matched nothing.
--
-- On a single-paste apply-all.sql this error is not local: the statements after it never
-- run. Every migration from here on was being blocked by these two lines.
create policy "whatsapp_groups_admin_write"
  on public.whatsapp_groups for all
  using (public.is_admin())
  with check (public.is_admin());

-- Why there is NO `grant execute on function public.is_admin() to authenticated` here.
--
-- The policy above is real, but it is unreachable from a browser session, and that is
-- the intended posture: `whatsapp_groups` carries no INSERT/UPDATE/DELETE privilege for
-- `anon` or `authenticated`, and the admin screen writes it through the service role
-- (`src/app/api/admin/groups/route.ts`). A policy is only evaluated for a role that
-- holds a table privilege in the first place.
--
-- An earlier version of this file granted is_admin() to authenticated on the reasoning
-- that a policy is evaluated AS THE QUERYING ROLE. That is true, but it only matters
-- once clients can write the table, which they cannot — and the grant would have broken
-- 0004's deliberate invariant (asserted by tests/sql/60_security.sql) to enable a path
-- nothing uses. The rule to remember instead:
--
--   IF you ever grant write privileges on this table to `authenticated`, you MUST also
--   grant execute on public.is_admin() to it in the same migration, or every such write
--   fails with "permission denied for function is_admin".
--
-- Until then, admin writes belong in an API route with requireAdmin(), which is where
-- they are.

-- RPC: get the user's assigned group (by user number).
create or replace function public.my_whatsapp_group()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid;
  v_user_num integer;
  v_group    public.whatsapp_groups;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    return null;
  end if;

  -- Determine user's position by created_at order.
  select count(*) into v_user_num
    from public.profiles
   where created_at <= (select created_at from public.profiles where id = v_user_id);

  select * into v_group from public.whatsapp_groups
   where is_active = true
     and v_user_num > user_start
     and v_user_num <= user_end
   order by sort_order
   limit 1;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_group.id,
    'name', v_group.name,
    'invite_link', v_group.invite_link,
    'user_range', v_group.user_start || '-' || v_group.user_end
  );
end;
$$;


-- ── 6. WIRE DEPOSIT BONUS INTO SETTLEMENT ───────────────────────────────────
-- After deposit_credit settles, also apply the bonus.
-- This is done by modifying the deposit_credit function to call the bonus.

create or replace function public.deposit_credit(
  p_merchant_reference      text,
  p_provider_transaction_id text default null,
  p_provider_reference      text default null,
  p_amount                  numeric default null,
  p_payload                 jsonb default null
)
returns table (
  id                    uuid,
  user_id               uuid,
  amount                numeric,
  currency              text,
  credited              boolean,
  wallet_transaction_id uuid,
  bonus_amount          numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dep   public.deposits;
  v_tx    public.wallet_transactions;
  v_bonus numeric := 0;
begin
  select * into v_dep from public.deposits
   where merchant_reference = p_merchant_reference
     and status in ('PENDING', 'PROCESSING')
   for update;

  if not found then
    -- Check if already completed — idempotent.
    select * into v_dep from public.deposits
     where merchant_reference = p_merchant_reference
       and status = 'COMPLETED';
    if found then
      return query select v_dep.id, v_dep.user_id, v_dep.amount, v_dep.currency,
                         false, v_dep.wallet_transaction_id, 0::numeric;
      return;
    end if;
    raise exception 'DEPOSIT_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- Optional amount verification.
  if p_amount is not null and p_amount <> v_dep.amount then
    raise exception 'DEPOSIT_AMOUNT_MISMATCH' using errcode = 'P0001';
  end if;

  -- Provider TX deduplication.
  if p_provider_transaction_id is not null then
    if exists (
      select 1 from public.deposits
       where provider_transaction_id = p_provider_transaction_id
         and id <> v_dep.id
    ) then
      raise exception 'DEPOSIT_PROVIDER_TX_REUSED' using errcode = 'P0001';
    end if;
  end if;

  v_tx := public.wallet_post(
    p_user_id            => v_dep.user_id,
    p_type               => 'DEPOSIT',
    p_amount             => v_dep.amount,
    p_status             => 'COMPLETED',
    p_reference          => 'DEP-' || v_dep.id::text,
    p_external_reference => coalesce(p_provider_transaction_id, p_merchant_reference),
    p_description        => 'Deposit via ' || v_dep.provider,
    p_metadata           => jsonb_build_object(
                              'merchant_reference', p_merchant_reference,
                              'phone', v_dep.phone,
                              'provider', v_dep.provider
                            ),
    p_source             => 'MPESA'
  );

  update public.deposits
     set status = 'COMPLETED',
         provider_transaction_id = coalesce(p_provider_transaction_id, provider_transaction_id),
         provider_reference = coalesce(p_provider_reference, p_merchant_reference),
         callback_payload = coalesce(p_payload, callback_payload),
         verified_at = now(),
         completed_at = now(),
         wallet_transaction_id = v_tx.id,
         failure_reason = null
   where id = v_dep.id;

  -- Apply deposit bonus
  v_bonus := public.apply_deposit_bonus(v_dep.user_id, v_dep.amount, v_dep.currency, v_dep.id);

  -- Referral commission on deposit
  perform public.referral_commission_on_deposit(v_dep.user_id, v_tx.id, v_dep.amount, v_dep.currency);

  perform public.notify_user(
    v_dep.user_id, 'DEPOSIT_COMPLETED',
    'Deposit confirmed',
    'Your deposit of ' || v_dep.currency || ' ' || to_char(v_dep.amount, 'FM999,999,990.00') ||
      ' has been confirmed and credited to your wallet.' ||
      case when v_bonus > 0 then ' Plus a bonus of KES ' || to_char(v_bonus, 'FM999,999,990.00') || '!' else '' end,
    'SUCCESS', '/dashboard/wallet'
  );

  return query select v_dep.id, v_dep.user_id, v_dep.amount, v_dep.currency,
                     true, v_tx.id, v_bonus;
end;
$$;
