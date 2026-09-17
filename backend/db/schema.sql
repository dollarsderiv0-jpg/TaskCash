-- WATCHREWARDS — PostgreSQL schema (Supabase compatible)
-- Idempotent: safe to run repeatedly.
--
-- Accounting rules enforced by this schema:
--   * balances live on `users` but every movement is mirrored by an immutable
--     row in `wallet_transactions` (the ledger);
--   * `wallet_transactions.idempotency_key` is UNIQUE, so a duplicated payment
--     provider callback can never credit the same event twice;
--   * `watch_sessions` is the only evidence that can unlock a watch reward.

CREATE TABLE IF NOT EXISTS users (
  id                SERIAL PRIMARY KEY,
  fullname          VARCHAR(120) NOT NULL,
  username          VARCHAR(40)  NOT NULL UNIQUE,
  email             VARCHAR(160) NOT NULL UNIQUE,
  phone             VARCHAR(20)  NOT NULL,          -- 07XXXXXXXX / 2547XXXXXXXX
  payout_phone      VARCHAR(20),                    -- M-Pesa payout number (section 19)
  password_hash     VARCHAR(200) NOT NULL,
  role              VARCHAR(20)  NOT NULL DEFAULT 'user',   -- user | admin
  status            VARCHAR(20)  NOT NULL DEFAULT 'active', -- active | suspended
  email_verified    BOOLEAN      NOT NULL DEFAULT FALSE,
  referred_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  balance           NUMERIC(14,2) NOT NULL DEFAULT 0,       -- withdrawable
  pending_balance   NUMERIC(14,2) NOT NULL DEFAULT 0,       -- reserved (withdrawals in flight)
  total_earned      NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_deposited   NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_withdrawn   NUMERIC(14,2) NOT NULL DEFAULT 0,
  referral_earnings NUMERIC(14,2) NOT NULL DEFAULT 0,
  referral_code     VARCHAR(16)  NOT NULL UNIQUE,
  watched_count     INTEGER      NOT NULL DEFAULT 0,
  currency_code     VARCHAR(10)  NOT NULL DEFAULT 'KES',
  last_login        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── Content (admin managed, section 22) ─────────────────────
CREATE TABLE IF NOT EXISTS videos (
  id               SERIAL PRIMARY KEY,
  title            VARCHAR(160) NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  video_url        TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  reward           NUMERIC(10,2) NOT NULL,
  currency_code    VARCHAR(10) NOT NULL DEFAULT 'KES',
  daily_limit      INTEGER NOT NULL DEFAULT 1,   -- per-user completions per day
  status           VARCHAR(20) NOT NULL DEFAULT 'active', -- active | inactive
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Watch sessions (server-side proof of watching) ──────────
CREATE TABLE IF NOT EXISTS watch_sessions (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id         INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  status           VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | completed | expired | failed
  required_seconds INTEGER NOT NULL,
  watched_seconds  INTEGER NOT NULL DEFAULT 0,
  progress_pct     NUMERIC(5,2) NOT NULL DEFAULT 0,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ping_at     TIMESTAMPTZ,
  verified_at      TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  reward_amount    NUMERIC(10,2) NOT NULL DEFAULT 0,
  currency_code    VARCHAR(10) NOT NULL DEFAULT 'KES',
  reward_txn_id    VARCHAR(40),
  client_ip        VARCHAR(60),
  user_agent       VARCHAR(300),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Deposits (M-Pesa collections) ───────────────────────────
CREATE TABLE IF NOT EXISTS deposits (
  id                SERIAL PRIMARY KEY,
  txn_id            VARCHAR(40)  NOT NULL UNIQUE,     -- WR-xxxxxx reference shown to the user
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount            NUMERIC(12,2) NOT NULL,
  currency_code     VARCHAR(10) NOT NULL DEFAULT 'KES',
  payment_method    VARCHAR(20) NOT NULL DEFAULT 'mpesa',
  phone             VARCHAR(20) NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | successful | failed
  provider          VARCHAR(40),
  provider_ref      VARCHAR(120),      -- e.g. M-Pesa CheckoutRequestID
  payment_reference VARCHAR(120),      -- e.g. verified M-Pesa receipt number
  idempotency_key   VARCHAR(140) UNIQUE,
  failure_reason    TEXT,
  verified_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Withdrawals (M-Pesa payouts) ────────────────────────────
CREATE TABLE IF NOT EXISTS withdrawals (
  id              SERIAL PRIMARY KEY,
  request_id      VARCHAR(40)  NOT NULL UNIQUE,   -- WRW-xxxxxx request reference
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount          NUMERIC(12,2) NOT NULL,         -- gross, reserved from balance
  fee             NUMERIC(10,2) NOT NULL DEFAULT 0,
  net_amount      NUMERIC(12,2) NOT NULL,
  currency_code   VARCHAR(10) NOT NULL DEFAULT 'KES',
  method          VARCHAR(20) NOT NULL DEFAULT 'mpesa',
  destination     VARCHAR(20) NOT NULL,           -- normalised 2547XXXXXXXX
  status          VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | processing | completed | failed
  provider        VARCHAR(40),
  provider_ref    VARCHAR(120),
  receipt         VARCHAR(120),
  idempotency_key VARCHAR(140) UNIQUE,
  failure_reason  TEXT,
  processed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  processed_at    TIMESTAMPTZ,
  verified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Immutable wallet ledger ─────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id              SERIAL PRIMARY KEY,
  txn_id          VARCHAR(40) NOT NULL UNIQUE,     -- unique transaction ID
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            VARCHAR(30) NOT NULL,            -- DEPOSIT|WATCH_REWARD|REFERRAL_REWARD|WITHDRAWAL|FEE|REVERSAL
  status          VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING|COMPLETED|FAILED|REVERSED
  amount          NUMERIC(14,2) NOT NULL,          -- positive magnitude; direction comes from `type`
  currency_code   VARCHAR(10) NOT NULL DEFAULT 'KES',
  description     VARCHAR(200) NOT NULL DEFAULT '',
  reference       VARCHAR(120),
  provider        VARCHAR(40),
  provider_ref    VARCHAR(120),
  idempotency_key VARCHAR(140) UNIQUE,
  balance_after   NUMERIC(14,2),
  metadata        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Referrals ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id               SERIAL PRIMARY KEY,
  referrer_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  level            INTEGER NOT NULL DEFAULT 1,
  commission       NUMERIC(12,2) NOT NULL DEFAULT 0,
  qualified_at     TIMESTAMPTZ,   -- set when the referral reward was credited
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Notifications ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title      VARCHAR(160) NOT NULL,
  message    TEXT NOT NULL,
  type       VARCHAR(20) NOT NULL DEFAULT 'info', -- info|success|warning|danger
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  link       VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Password reset tokens ───────────────────────────────────
CREATE TABLE IF NOT EXISTS email_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      VARCHAR(80) NOT NULL UNIQUE,
  type       VARCHAR(20) NOT NULL,   -- reset
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Configurable platform settings (sections 11, 15, 21) ────
CREATE TABLE IF NOT EXISTS app_settings (
  key        VARCHAR(60) PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Login sessions (section 20) ────────────────────────────
CREATE TABLE IF NOT EXISTS login_sessions (
  id           SERIAL PRIMARY KEY,
  session_id   VARCHAR(40) NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip           VARCHAR(60),
  user_agent   VARCHAR(300),
  revoked      BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Admin audit trail ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          SERIAL PRIMARY KEY,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_role  VARCHAR(20),
  action      VARCHAR(80) NOT NULL,
  target_type VARCHAR(40),
  target_id   VARCHAR(40),
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_referred_by    ON users(referred_by);
CREATE INDEX IF NOT EXISTS idx_videos_status        ON videos(status);
CREATE INDEX IF NOT EXISTS idx_ws_user_created      ON watch_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ws_video             ON watch_sessions(video_id);
CREATE INDEX IF NOT EXISTS idx_deposits_user        ON deposits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user     ON withdrawals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user   ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer   ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_ledger_user          ON wallet_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_status        ON wallet_transactions(status);
CREATE INDEX IF NOT EXISTS idx_audit_created        ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user        ON login_sessions(user_id, created_at DESC);

-- Legacy deployments: add newer columns if the tables already exist.
ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_phone      VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_deposited   NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_withdrawn   NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS watched_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS currency_code     VARCHAR(10) NOT NULL DEFAULT 'KES';
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS txn_id              VARCHAR(40);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS currency_code       VARCHAR(10);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS provider            VARCHAR(40);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS payment_reference   VARCHAR(120);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS idempotency_key     VARCHAR(140);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS verified_at         TIMESTAMPTZ;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS request_id       VARCHAR(40);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS currency_code    VARCHAR(10);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS provider         VARCHAR(40);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS receipt          VARCHAR(120);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS idempotency_key  VARCHAR(140);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS failure_reason   TEXT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS processed_by     INTEGER;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS processed_at     TIMESTAMPTZ;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS verified_at      TIMESTAMPTZ;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS qualified_at       TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link           VARCHAR(200);
