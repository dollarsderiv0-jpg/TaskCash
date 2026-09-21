-- ============================================================================
-- TaskCash Pro — 0001 Schema
-- All money-touching tables. Balances live on `wallets` but are only ever
-- mutated by the atomic functions in 0002_money_functions.sql, each of which
-- writes an immutable `wallet_transactions` row in the same DB transaction.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- currencies — makes additional countries/currencies additive, not a rewrite
-- ---------------------------------------------------------------------------
create table if not exists public.currencies (
  code                text primary key,
  name                text not null,
  symbol              text not null,
  minor_unit          int  not null default 2 check (minor_unit between 0 and 4),
  min_deposit         numeric(20,4) not null default 0 check (min_deposit >= 0),
  min_withdrawal      numeric(20,4) not null default 0 check (min_withdrawal >= 0),
  max_withdrawal      numeric(20,4) not null default 100000 check (max_withdrawal > 0),
  withdrawal_fee      numeric(20,4) not null default 0 check (withdrawal_fee >= 0),
  enabled             boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

drop trigger if exists trg_currencies_updated on public.currencies;
create trigger trg_currencies_updated before update on public.currencies
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- profiles — application user, 1:1 with auth.users
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id                uuid primary key default gen_random_uuid(),
  auth_user_id      uuid not null unique references auth.users(id) on delete cascade,
  full_name         text not null check (length(trim(full_name)) between 2 and 120),
  email             text not null unique,
  phone             text not null,
  country           text not null default 'KE' check (length(country) = 2),
  currency          text not null references public.currencies(code),
  referral_code     text not null unique check (referral_code ~ '^TC[A-Z0-9]{5,10}$'),
  referred_by       uuid references public.profiles(id) on delete set null,
  status            text not null default 'PENDING'
                      check (status in ('PENDING','ACTIVE','RESTRICTED','SUSPENDED','CLOSED')),
  kyc_status        text not null default 'NOT_STARTED'
                      check (kyc_status in ('NOT_STARTED','PENDING','VERIFIED','REJECTED','REQUIRES_REVIEW')),
  role              text not null default 'USER'
                      check (role in ('USER','ADMIN','SUPER_ADMIN')),
  risk_status       text not null default 'NORMAL'
                      check (risk_status in ('NORMAL','REVIEW','RESTRICTED','SUSPENDED')),
  risk_score        int not null default 0 check (risk_score between 0 and 100),
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  last_login_at     timestamptz,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint profiles_not_self_referred check (referred_by is null or referred_by <> id)
);

drop trigger if exists trg_profiles_updated on public.profiles;
create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.touch_updated_at();

create index if not exists idx_profiles_referred_by on public.profiles(referred_by);
create index if not exists idx_profiles_status on public.profiles(status);
create index if not exists idx_profiles_created_at on public.profiles(created_at desc);

-- ---------------------------------------------------------------------------
-- wallets
-- ---------------------------------------------------------------------------
create table if not exists public.wallets (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null unique references public.profiles(id) on delete cascade,
  currency           text not null references public.currencies(code),
  available_balance  numeric(20,4) not null default 0 check (available_balance >= 0),
  locked_balance     numeric(20,4) not null default 0 check (locked_balance >= 0),
  -- A wallet can be frozen on its own, without touching the account status.
  -- wallet_post() refuses any movement while a wallet is not ACTIVE, so a
  -- freeze always fails closed.
  status             text not null default 'ACTIVE' check (status in ('ACTIVE','FROZEN','CLOSED')),
  frozen_reason      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

drop trigger if exists trg_wallets_updated on public.wallets;
create trigger trg_wallets_updated before update on public.wallets
  for each row execute function public.touch_updated_at();

create index if not exists idx_wallets_user_id on public.wallets(user_id);

-- ---------------------------------------------------------------------------
-- wallet_transactions — the immutable ledger
-- ---------------------------------------------------------------------------
create table if not exists public.wallet_transactions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete restrict,
  wallet_id           uuid not null references public.wallets(id) on delete restrict,
  type                text not null check (type in (
                        'DEPOSIT','VIDEO_REWARD','TASK_REWARD','REFERRAL_REWARD',
                        'WITHDRAWAL_HOLD','WITHDRAWAL','WITHDRAWAL_FEE','WITHDRAWAL_RELEASE',
                        'REFUND','REVERSAL','ADMIN_ADJUSTMENT')),
  amount              numeric(20,4) not null,
  currency            text not null references public.currencies(code),
  status              text not null default 'COMPLETED' check (status in (
                        'PENDING','PROCESSING','COMPLETED','FAILED','REJECTED','CANCELLED','REVERSED')),
  direction           text not null default 'CREDIT' check (direction in ('CREDIT','DEBIT')),
  -- signed effect on each balance bucket, computed by the ledger function
  available_delta     numeric(20,4) not null default 0,
  locked_delta        numeric(20,4) not null default 0,
  balance_after       numeric(20,4) not null default 0,
  reference           text not null unique,
  external_reference  text,
  description         text,
  metadata            jsonb not null default '{}'::jsonb,
  source              text not null default 'SYSTEM' check (length(source) between 2 and 40),
  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz,
  constraint wallet_tx_amount_nonzero check (amount <> 0 or type = 'ADMIN_ADJUSTMENT'),
  constraint wallet_tx_positive_amount check (type = 'ADMIN_ADJUSTMENT' or amount > 0)
);

-- The ledger is append-only: no updated_at trigger, and UPDATE/DELETE are
-- additionally blocked for non-service roles in 0003_rls.sql.

create index if not exists idx_wallet_tx_user_created on public.wallet_transactions(user_id, created_at desc);
create index if not exists idx_wallet_tx_type on public.wallet_transactions(type);
create index if not exists idx_wallet_tx_status on public.wallet_transactions(status);
create index if not exists idx_wallet_tx_reference on public.wallet_transactions(reference);
create index if not exists idx_wallet_tx_external_reference on public.wallet_transactions(external_reference);
create index if not exists idx_wallet_tx_wallet_created on public.wallet_transactions(wallet_id, created_at desc);

-- ---------------------------------------------------------------------------
-- deposits (SasaPay C2B collections)
-- ---------------------------------------------------------------------------
create table if not exists public.deposits (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles(id) on delete restrict,
  wallet_id              uuid not null references public.wallets(id) on delete restrict,
  amount                 numeric(20,4) not null check (amount > 0),
  currency               text not null references public.currencies(code),
  phone                  text not null,
  provider               text not null default 'SASAPAY',
  provider_transaction_id text unique,
  merchant_reference     text not null unique,
  provider_reference     text,
  status                 text not null default 'PENDING' check (status in (
                           'PENDING','PROCESSING','COMPLETED','FAILED','REJECTED','CANCELLED','REVERSED')),
  failure_reason         text,
  idempotency_key        text unique,
  callback_payload       jsonb,
  verified_at            timestamptz,
  wallet_transaction_id  uuid references public.wallet_transactions(id) on delete restrict,
  created_at             timestamptz not null default now(),
  completed_at           timestamptz
);

create index if not exists idx_deposits_user_created on public.deposits(user_id, created_at desc);
create index if not exists idx_deposits_status on public.deposits(status);
create index if not exists idx_deposits_merchant_reference on public.deposits(merchant_reference);
create index if not exists idx_deposits_provider_reference on public.deposits(provider_reference);

-- ---------------------------------------------------------------------------
-- withdrawals (admin-approved B2C disbursements)
-- ---------------------------------------------------------------------------
create table if not exists public.withdrawals (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.profiles(id) on delete restrict,
  wallet_id               uuid not null references public.wallets(id) on delete restrict,
  amount                  numeric(20,4) not null check (amount > 0),
  fee                     numeric(20,4) not null default 0 check (fee >= 0),
  net_amount              numeric(20,4) not null default 0 check (net_amount >= 0),
  currency                text not null references public.currencies(code),
  phone                   text not null,
  status                  text not null default 'PENDING_ADMIN_APPROVAL' check (status in (
                            'PENDING_ADMIN_APPROVAL','APPROVED','PROCESSING','COMPLETED',
                            'FAILED','REJECTED','CANCELLED','REVERSED')),
  risk_score              int not null default 0,
  admin_id                uuid references public.profiles(id) on delete set null,
  admin_approved_at       timestamptz,
  admin_rejected_at       timestamptz,
  rejection_reason        text,
  provider                text not null default 'SASAPAY',
  provider_transaction_id text unique,
  provider_reference      text unique,
  provider_request        jsonb,
  provider_response       jsonb,
  idempotency_key         text not null unique,
  failure_reason          text,
  requested_at            timestamptz not null default now(),
  completed_at            timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint withdrawals_net_amount_sane check (net_amount = amount - fee)
);

drop trigger if exists trg_withdrawals_updated on public.withdrawals;
create trigger trg_withdrawals_updated before update on public.withdrawals
  for each row execute function public.touch_updated_at();

create index if not exists idx_withdrawals_user_created on public.withdrawals(user_id, created_at desc);
create index if not exists idx_withdrawals_status on public.withdrawals(status);
create index if not exists idx_withdrawals_requested_at on public.withdrawals(requested_at desc);
create index if not exists idx_withdrawals_provider_reference on public.withdrawals(provider_reference);

-- ---------------------------------------------------------------------------
-- video campaigns & videos
-- ---------------------------------------------------------------------------
create table if not exists public.video_campaigns (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(trim(name)) between 2 and 160),
  description     text,
  advertiser      text,
  budget          numeric(20,4) not null default 0 check (budget >= 0),
  spent           numeric(20,4) not null default 0 check (spent >= 0),
  reward_per_view numeric(20,4) not null default 0 check (reward_per_view >= 0),
  max_views       int check (max_views is null or max_views > 0),
  total_views     int not null default 0 check (total_views >= 0),
  start_at        timestamptz,
  end_at          timestamptz,
  status          text not null default 'DRAFT' check (status in (
                    'DRAFT','ACTIVE','PAUSED','EXPIRED','COMPLETED','SUSPENDED')),
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint video_campaigns_budget_not_exceeded check (spent <= budget),
  constraint video_campaigns_window check (end_at is null or start_at is null or end_at > start_at)
);

drop trigger if exists trg_video_campaigns_updated on public.video_campaigns;
create trigger trg_video_campaigns_updated before update on public.video_campaigns
  for each row execute function public.touch_updated_at();

create index if not exists idx_video_campaigns_status on public.video_campaigns(status);

create table if not exists public.videos (
  id                     uuid primary key default gen_random_uuid(),
  campaign_id            uuid references public.video_campaigns(id) on delete set null,
  title                  text not null check (length(trim(title)) between 2 and 200),
  description            text,
  video_url              text not null,
  thumbnail_url          text,
  duration_seconds       int not null check (duration_seconds between 5 and 36000),
  required_watch_seconds int not null check (required_watch_seconds > 0),
  reward_amount          numeric(20,4) not null check (reward_amount >= 0),
  currency               text not null references public.currencies(code),
  daily_limit            int not null default 1 check (daily_limit >= 0),
  total_view_limit       int check (total_view_limit is null or total_view_limit > 0),
  total_views            int not null default 0 check (total_views >= 0),
  status                 text not null default 'DRAFT' check (status in (
                           'DRAFT','ACTIVE','PAUSED','EXPIRED','COMPLETED','SUSPENDED')),
  created_by             uuid references public.profiles(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint videos_required_within_duration check (required_watch_seconds <= duration_seconds)
);

drop trigger if exists trg_videos_updated on public.videos;
create trigger trg_videos_updated before update on public.videos
  for each row execute function public.touch_updated_at();

create index if not exists idx_videos_status on public.videos(status);
create index if not exists idx_videos_campaign on public.videos(campaign_id);

-- ---------------------------------------------------------------------------
-- video_watch_sessions — server-authoritative watch tracking
-- ---------------------------------------------------------------------------
create table if not exists public.video_watch_sessions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles(id) on delete cascade,
  video_id               uuid not null references public.videos(id) on delete restrict,
  session_token          uuid not null unique default gen_random_uuid(),
  status                 text not null default 'STARTED' check (status in (
                           'STARTED','WATCHING','COMPLETED','REWARDED','EXPIRED','SUSPENDED','REJECTED')),
  started_at             timestamptz not null default now(),
  last_activity_at       timestamptz not null default now(),
  completed_at           timestamptz,
  rewarded_at            timestamptz,
  watched_seconds        numeric(10,2) not null default 0 check (watched_seconds >= 0),
  required_watch_seconds int not null,
  reward_amount          numeric(20,4),
  reward_transaction_id  uuid unique references public.wallet_transactions(id) on delete set null,
  reward_reference       text,
  reject_reason          text,
  ip_hash                text,
  device_hash            text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

drop trigger if exists trg_video_sessions_updated on public.video_watch_sessions;
create trigger trg_video_sessions_updated before update on public.video_watch_sessions
  for each row execute function public.touch_updated_at();

create index if not exists idx_video_sessions_user_created on public.video_watch_sessions(user_id, created_at desc);
create index if not exists idx_video_sessions_video on public.video_watch_sessions(video_id);
create index if not exists idx_video_sessions_status on public.video_watch_sessions(status);
create index if not exists idx_video_sessions_user_video_created
  on public.video_watch_sessions(user_id, video_id, created_at desc);

-- ---------------------------------------------------------------------------
-- referrals & commissions
-- ---------------------------------------------------------------------------
create table if not exists public.referrals (
  id                uuid primary key default gen_random_uuid(),
  referrer_id       uuid not null references public.profiles(id) on delete cascade,
  referred_user_id  uuid not null unique references public.profiles(id) on delete cascade,
  referral_code     text not null,
  level             int not null default 1 check (level in (1,2)),
  qualifying_event  text check (qualifying_event in (
                      'VERIFIED_REGISTRATION','KYC_VERIFIED','ELIGIBLE_DEPOSIT','QUALIFYING_TASK')),
  status            text not null default 'PENDING' check (status in ('PENDING','QUALIFIED','REJECTED')),
  created_at        timestamptz not null default now(),
  qualified_at      timestamptz,
  metadata          jsonb not null default '{}'::jsonb,
  constraint referrals_no_self check (referrer_id <> referred_user_id)
);

create index if not exists idx_referrals_referrer on public.referrals(referrer_id);
create index if not exists idx_referrals_status on public.referrals(status);
create index if not exists idx_referrals_code on public.referrals(referral_code);

create table if not exists public.referral_commissions (
  id                      uuid primary key default gen_random_uuid(),
  referrer_id             uuid not null references public.profiles(id) on delete restrict,
  referred_user_id        uuid not null references public.profiles(id) on delete restrict,
  amount                  numeric(20,4) not null check (amount > 0),
  currency                text not null references public.currencies(code),
  level                   int not null check (level in (1,2)),
  rate                    numeric(6,4) not null check (rate >= 0 and rate <= 1),
  base_amount             numeric(20,4) not null check (base_amount >= 0),
  status                  text not null default 'PENDING' check (status in ('PENDING','CREDITED','REVERSED')),
  qualifying_event        text not null,
  source_transaction_id   uuid references public.wallet_transactions(id) on delete set null,
  wallet_transaction_id   uuid unique references public.wallet_transactions(id) on delete set null,
  created_at              timestamptz not null default now(),
  credited_at             timestamptz,
  constraint referral_commissions_unique_event unique (
    referrer_id, referred_user_id, level, qualifying_event, source_transaction_id
  )
);

create index if not exists idx_referral_commissions_referrer on public.referral_commissions(referrer_id, created_at desc);
create index if not exists idx_referral_commissions_status on public.referral_commissions(status);

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  type        text not null,
  title       text not null,
  message     text not null,
  severity    text not null default 'INFO' check (severity in ('INFO','SUCCESS','WARNING','ERROR')),
  link        text,
  metadata    jsonb not null default '{}'::jsonb,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists idx_notifications_user_created on public.notifications(user_id, created_at desc);
create index if not exists idx_notifications_unread on public.notifications(user_id) where read_at is null;

-- ---------------------------------------------------------------------------
-- audit_logs — who did what, immutably
-- ---------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id           uuid primary key default gen_random_uuid(),
  admin_id     uuid references public.profiles(id) on delete set null,
  user_id      uuid references public.profiles(id) on delete set null,
  action       text not null,
  entity_type  text not null,
  entity_id    text,
  description  text,
  metadata     jsonb not null default '{}'::jsonb,
  ip_hash      text,
  user_agent   text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_audit_logs_created on public.audit_logs(created_at desc);
create index if not exists idx_audit_logs_admin on public.audit_logs(admin_id);
create index if not exists idx_audit_logs_entity on public.audit_logs(entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- fraud_events
-- ---------------------------------------------------------------------------
create table if not exists public.fraud_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  event_type   text not null,
  severity     text not null default 'LOW' check (severity in ('LOW','MEDIUM','HIGH','CRITICAL')),
  score        int not null default 0 check (score between 0 and 100),
  details      jsonb not null default '{}'::jsonb,
  status       text not null default 'OPEN' check (status in ('OPEN','REVIEWING','CLEARED','CONFIRMED')),
  reviewed_by  uuid references public.profiles(id) on delete set null,
  reviewed_at  timestamptz,
  review_note  text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_fraud_events_user on public.fraud_events(user_id, created_at desc);
create index if not exists idx_fraud_events_status on public.fraud_events(status, created_at desc);
create index if not exists idx_fraud_events_type on public.fraud_events(event_type);

-- ---------------------------------------------------------------------------
-- system_settings — every business rule that must be admin-configurable
-- ---------------------------------------------------------------------------
create table if not exists public.system_settings (
  key          text primary key,
  value        jsonb not null,
  type         text not null default 'json' check (type in ('string','number','boolean','json')),
  category     text not null default 'general',
  description  text,
  is_public    boolean not null default false,
  updated_by   uuid references public.profiles(id) on delete set null,
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- idempotency_keys — protects deposit/withdraw creation from double submits
-- ---------------------------------------------------------------------------
create table if not exists public.idempotency_keys (
  key          text primary key,
  user_id      uuid references public.profiles(id) on delete cascade,
  scope        text not null,
  response     jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists idx_idempotency_user on public.idempotency_keys(user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- payment_events — raw provider callbacks for reconciliation & duplicate detection
-- ---------------------------------------------------------------------------
create table if not exists public.payment_events (
  id                      uuid primary key default gen_random_uuid(),
  provider                text not null default 'SASAPAY',
  direction               text not null check (direction in ('COLLECTION','DISBURSEMENT')),
  provider_transaction_id text,
  merchant_reference      text,
  outcome                 text,
  signature_valid         boolean not null default false,
  processed               boolean not null default false,
  duplicate               boolean not null default false,
  payload                 jsonb not null,
  error                   text,
  created_at              timestamptz not null default now()
);

create unique index if not exists uq_payment_events_dedupe
  on public.payment_events(provider, direction, provider_transaction_id)
  where provider_transaction_id is not null;

create index if not exists idx_payment_events_created on public.payment_events(created_at desc);

-- ---------------------------------------------------------------------------
-- rate_limits — serverless-safe sliding-ish window counter
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limits (
  bucket        text not null,
  identifier    text not null,
  window_start  timestamptz not null,
  hits          int not null default 0,
  created_at    timestamptz not null default now(),
  primary key (bucket, identifier, window_start)
);

create index if not exists idx_rate_limits_created on public.rate_limits(created_at desc);

-- ---------------------------------------------------------------------------
-- reconciliation_alerts
-- ---------------------------------------------------------------------------
create table if not exists public.reconciliation_alerts (
  id            uuid primary key default gen_random_uuid(),
  alert_type    text not null check (alert_type in (
                  'PAYMENT_NOT_CREDITED','CREDIT_WITHOUT_PROVIDER','PROVIDER_COMPLETED_MISSING_LOCAL',
                  'DUPLICATE_CALLBACK','REFERENCE_MISMATCH','AMOUNT_MISMATCH','STALE_PENDING')),
  severity      text not null default 'MEDIUM' check (severity in ('LOW','MEDIUM','HIGH','CRITICAL')),
  entity_type   text not null,
  entity_id     text,
  reference     text,
  details       jsonb not null default '{}'::jsonb,
  status        text not null default 'OPEN' check (status in ('OPEN','RESOLVED','IGNORED')),
  resolved_by   uuid references public.profiles(id) on delete set null,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists idx_recon_alerts_status on public.reconciliation_alerts(status, created_at desc);

-- ---------------------------------------------------------------------------
-- derived wallet totals (authoritative, computed from the ledger)
-- ---------------------------------------------------------------------------
-- security_invoker is essential: without it the view would run with the
-- owner's privileges and leak every wallet past RLS.
create or replace view public.wallet_totals with (security_invoker = true) as
select
  w.id                as wallet_id,
  w.user_id,
  w.currency,
  w.available_balance,
  w.locked_balance,
  w.available_balance + w.locked_balance as total_balance,
  coalesce(sum(case when t.type in ('DEPOSIT') and t.status = 'COMPLETED' then t.amount else 0 end), 0) as total_deposited,
  coalesce(sum(case when t.type = 'WITHDRAWAL' and t.status = 'COMPLETED' then t.amount else 0 end), 0) as total_withdrawn,
  -- "Earned" means rewards earned from eligible activity. Deposits and admin
  -- adjustments are deliberately excluded: labelling a user's own deposit as
  -- earnings would misrepresent where the money came from.
  coalesce(sum(case when t.type in ('VIDEO_REWARD','TASK_REWARD','REFERRAL_REWARD')
                     and t.status = 'COMPLETED' then t.amount else 0 end), 0) as total_earned,
  coalesce(sum(case when t.status = 'COMPLETED' then t.amount else 0 end), 0) as total_credits
from public.wallets w
left join public.wallet_transactions t on t.wallet_id = w.id
group by w.id, w.user_id, w.currency, w.available_balance, w.locked_balance;
