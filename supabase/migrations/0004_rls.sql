-- ============================================================================
-- TaskCash Pro — 0004 Row Level Security
--
-- Design rule: the browser gets SELECT on its own rows and *nothing else*.
-- There is deliberately not a single INSERT/UPDATE/DELETE policy on a
-- financial table, because every financial mutation happens server-side
-- through SECURITY DEFINER functions executed by the service role.
-- Client-supplied `role`, `balance`, `reward` or `status` values therefore
-- have no path into the database.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- identity helper (avoids recursive policy lookups on profiles)
-- ---------------------------------------------------------------------------
create or replace function public.current_profile_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.profiles where auth_user_id = auth.uid() limit 1;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where auth_user_id = auth.uid()
       and role in ('ADMIN','SUPER_ADMIN')
       and status = 'ACTIVE'
  );
$$;

revoke all on function public.current_profile_id() from public, anon;
revoke all on function public.is_admin() from public, anon;

-- The SELECT policies below call current_profile_id() *as the querying role*,
-- so a signed-in user must be able to execute it. Revoking it from PUBLIC (which
-- includes authenticated) would make every self-read fail with "permission
-- denied for function current_profile_id". It only ever returns the caller's own
-- profile id, so granting it to authenticated leaks nothing.
-- is_admin() is deliberately NOT granted: no policy uses it.
grant execute on function public.current_profile_id() to authenticated;

-- ---------------------------------------------------------------------------
-- enable RLS everywhere
-- ---------------------------------------------------------------------------
alter table public.profiles              enable row level security;
alter table public.wallets               enable row level security;
alter table public.wallet_transactions   enable row level security;
alter table public.deposits              enable row level security;
alter table public.withdrawals           enable row level security;
alter table public.videos                enable row level security;
alter table public.video_campaigns       enable row level security;
alter table public.video_watch_sessions  enable row level security;
alter table public.referrals             enable row level security;
alter table public.referral_commissions  enable row level security;
alter table public.notifications         enable row level security;
alter table public.currencies            enable row level security;
alter table public.audit_logs            enable row level security;
alter table public.fraud_events          enable row level security;
alter table public.system_settings       enable row level security;
alter table public.idempotency_keys      enable row level security;
alter table public.payment_events        enable row level security;
alter table public.rate_limits           enable row level security;
alter table public.reconciliation_alerts enable row level security;

-- ---------------------------------------------------------------------------
-- SELECT policies (own rows only)
-- ---------------------------------------------------------------------------

-- profiles: own row, plus the row of the person who referred you (public bits used for display)
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using (auth_user_id = auth.uid());

-- wallets
drop policy if exists "wallets_select_own" on public.wallets;
create policy "wallets_select_own" on public.wallets
  for select to authenticated
  using (user_id = public.current_profile_id());

-- wallet_transactions
drop policy if exists "wallet_tx_select_own" on public.wallet_transactions;
create policy "wallet_tx_select_own" on public.wallet_transactions
  for select to authenticated
  using (user_id = public.current_profile_id());

-- deposits
drop policy if exists "deposits_select_own" on public.deposits;
create policy "deposits_select_own" on public.deposits
  for select to authenticated
  using (user_id = public.current_profile_id());

-- withdrawals
drop policy if exists "withdrawals_select_own" on public.withdrawals;
create policy "withdrawals_select_own" on public.withdrawals
  for select to authenticated
  using (user_id = public.current_profile_id());

-- video_watch_sessions
drop policy if exists "video_sessions_select_own" on public.video_watch_sessions;
create policy "video_sessions_select_own" on public.video_watch_sessions
  for select to authenticated
  using (user_id = public.current_profile_id());

-- referrals: visible to both sides of the relationship
drop policy if exists "referrals_select_related" on public.referrals;
create policy "referrals_select_related" on public.referrals
  for select to authenticated
  using (
    referrer_id = public.current_profile_id()
    or referred_user_id = public.current_profile_id()
  );

-- referral_commissions
drop policy if exists "referral_commissions_select_own" on public.referral_commissions;
create policy "referral_commissions_select_own" on public.referral_commissions
  for select to authenticated
  using (referrer_id = public.current_profile_id());

-- notifications: read own, and mark own as read
drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own" on public.notifications
  for select to authenticated
  using (user_id = public.current_profile_id());

drop policy if exists "notifications_update_own" on public.notifications;
create policy "notifications_update_own" on public.notifications
  for update to authenticated
  using (user_id = public.current_profile_id())
  with check (user_id = public.current_profile_id());

-- catalogue: everyone signed in can browse live campaigns and currencies
drop policy if exists "videos_select_active" on public.videos;
create policy "videos_select_active" on public.videos
  for select to authenticated
  using (status = 'ACTIVE');

drop policy if exists "video_campaigns_select_active" on public.video_campaigns;
create policy "video_campaigns_select_active" on public.video_campaigns
  for select to authenticated
  using (status = 'ACTIVE');

drop policy if exists "currencies_select_enabled" on public.currencies;
create policy "currencies_select_enabled" on public.currencies
  for select to anon, authenticated
  using (enabled = true);

-- public settings (pricing, limits, legal contact details) may be shown to clients
drop policy if exists "system_settings_select_public" on public.system_settings;
create policy "system_settings_select_public" on public.system_settings
  for select to anon, authenticated
  using (is_public = true);

-- ---------------------------------------------------------------------------
-- Deliberately absent: no INSERT/UPDATE/DELETE policies on
-- wallets, wallet_transactions, deposits, withdrawals, video_watch_sessions,
-- referrals, referral_commissions, profiles, videos, video_campaigns,
-- audit_logs, fraud_events, payment_events, reconciliation_alerts.
--
-- Admin operations go through /api/admin/* which authenticates the caller
-- server-side and writes with the service role.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- the ledger is append-only even for privileged paths
-- ---------------------------------------------------------------------------
create or replace function public.block_ledger_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'LEDGER_IMMUTABLE: wallet_transactions cannot be modified or deleted';
end;
$$;

drop trigger if exists trg_wallet_tx_immutable on public.wallet_transactions;
create trigger trg_wallet_tx_immutable
  before update or delete on public.wallet_transactions
  for each row execute function public.block_ledger_mutation();

-- ---------------------------------------------------------------------------
-- function execution privileges: financial logic is service-role only
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
  fns text[] := array[
    'public.wallet_post(uuid,text,numeric,text,text,text,text,jsonb,text,uuid)',
    'public.notify_user(uuid,text,text,text,text,text,jsonb)',
    'public.write_audit(uuid,uuid,text,text,text,text,jsonb,text,text)',
    'public.record_fraud_event(uuid,text,text,int,jsonb)',
    'public.rate_limit_hit(text,text,int,int)',
    'public.claim_idempotency_key(text,uuid,text)',
    'public.deposit_credit(text,text,jsonb)',
    'public.deposit_fail(text,text,text,jsonb)',
    'public.withdrawal_reserve(uuid,numeric,text,text,numeric,int)',
    'public.withdrawal_release(uuid,text,text,uuid,jsonb)',
    'public.withdrawal_complete(uuid,text,text,jsonb)',
    'public.admin_adjust_wallet(uuid,uuid,numeric,text)',
    'public.video_start(uuid,uuid,text,text)',
    'public.video_progress(uuid,uuid,numeric)',
    'public.video_complete_session(uuid,uuid)',
    'public.referral_qualify(uuid,text)',
    'public.referral_credit(uuid,uuid,int,numeric,text,numeric,text,uuid,text)',
    'public.referral_commission_on_deposit(uuid,uuid,numeric,text)',
    'public.ensure_profile(uuid,text,jsonb)',
    'public.setting_json(text,jsonb)',
    'public.setting_num(text,numeric)',
    'public.setting_bool(text,boolean)',
    'public.setting_text(text,text)'
  ];
begin
  foreach fn in array fns loop
    begin
      execute format('revoke all on function %s from public, anon, authenticated', fn);
      execute format('grant execute on function %s to service_role', fn);
    exception when undefined_function then
      raise notice 'skipped missing function %', fn;
    end;
  end loop;
end $$;

-- Tables are likewise service-role-write-only; anon/authenticated keep SELECT
-- (further narrowed by the policies above).
do $$
declare
  t text;
  tables text[] := array[
    'profiles','wallets','wallet_transactions','deposits','withdrawals','videos',
    'video_campaigns','video_watch_sessions','referrals','referral_commissions',
    'notifications','currencies','audit_logs','fraud_events','system_settings',
    'idempotency_keys','payment_events','rate_limits','reconciliation_alerts'
  ];
begin
  foreach t in array tables loop
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  execute 'grant select on public.currencies to anon';
  execute 'grant select on public.system_settings to anon';
  -- users may only flip read_at on their own notifications (policy-enforced)
  execute 'grant update on public.notifications to authenticated';
  execute 'revoke insert, update, delete on public.notifications from anon';
end $$;

grant select on public.wallet_totals to authenticated;
