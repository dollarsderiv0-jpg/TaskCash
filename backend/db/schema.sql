-- TaskCash — PostgreSQL schema (Supabase compatible)
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  fullname        VARCHAR(120) NOT NULL,
  username        VARCHAR(40)  NOT NULL UNIQUE,
  email           VARCHAR(160) NOT NULL UNIQUE,
  phone           VARCHAR(20)  NOT NULL,
  country         VARCHAR(60)  NOT NULL DEFAULT '',
  country_code    VARCHAR(2),
  currency        VARCHAR(10),
  currency_code   VARCHAR(10),
  password_hash   VARCHAR(200) NOT NULL,
  role            VARCHAR(20)  NOT NULL DEFAULT 'user',   -- user | admin
  status          VARCHAR(20)  NOT NULL DEFAULT 'active', -- active | suspended
  email_verified  BOOLEAN      NOT NULL DEFAULT FALSE,
  kyc_status      VARCHAR(20)  NOT NULL DEFAULT 'unverified', -- unverified | pending | verified
  referred_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  balance         NUMERIC(14,2) NOT NULL DEFAULT 0,
  pending_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_earned    NUMERIC(14,2) NOT NULL DEFAULT 0,
  referral_earnings NUMERIC(14,2) NOT NULL DEFAULT 0,
  package_id      INTEGER,
  package_expires TIMESTAMPTZ,
  referral_code   VARCHAR(16)  NOT NULL UNIQUE,
  checkin_streak  INTEGER      NOT NULL DEFAULT 0,
  last_checkin    DATE,
  tasks_completed INTEGER      NOT NULL DEFAULT 0,
  last_login      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS packages (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(40) NOT NULL UNIQUE,
  price       NUMERIC(12,2) NOT NULL,
  daily_tasks INTEGER NOT NULL DEFAULT 3,
  benefits    TEXT,
  duration_days INTEGER NOT NULL DEFAULT 30,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id                SERIAL PRIMARY KEY,
  title             VARCHAR(160) NOT NULL,
  description       TEXT NOT NULL,
  category          VARCHAR(40) NOT NULL,   -- video|social|survey|website|affiliate|app|referral|checkin
  reward            NUMERIC(10,2) NOT NULL,
  availability_type VARCHAR(20) NOT NULL DEFAULT 'global', -- global|countries
  countries         TEXT,                     -- JSON array of ISO2 codes, e.g. ["KE","UG"]
  time_required     VARCHAR(40),
  verification_type VARCHAR(30) NOT NULL,   -- code|screenshot|manual|auto
  url               TEXT,
  instructions      TEXT,
  verification_code VARCHAR(20),           -- expected code for 'code' verification
  status            VARCHAR(20) NOT NULL DEFAULT 'active', -- active|inactive
  daily_limit       INTEGER NOT NULL DEFAULT 1,
  min_package       VARCHAR(40),            -- package name required, NULL = all users
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-country configured rewards for a task. A reward is defined by
-- (task, country, currency, amount) — never derived via exchange rates.
CREATE TABLE IF NOT EXISTS task_rewards (
  id            SERIAL PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  country_code  VARCHAR(2) NOT NULL,
  currency_code VARCHAR(10) NOT NULL,
  reward_amount NUMERIC(12,2) NOT NULL,
  UNIQUE (task_id, country_code)
);

CREATE TABLE IF NOT EXISTS task_completions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE, -- NULL for bonuses (check-in etc.)
  proof       TEXT,                    -- code or screenshot URL/data
  status      VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|approved|rejected
  reward_paid NUMERIC(10,2) NOT NULL DEFAULT 0,
  currency_code VARCHAR(10),           -- currency at the time of the transaction
  admin_note  TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deposits (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount         NUMERIC(12,2) NOT NULL,
  payment_method VARCHAR(20) NOT NULL DEFAULT 'mpesa',
  phone          VARCHAR(20),
  status         VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|approved|rejected|cancelled
  reference      VARCHAR(80),
  provider_ref   VARCHAR(120),
  failure_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      NUMERIC(12,2) NOT NULL,
  fee         NUMERIC(10,2) NOT NULL DEFAULT 0,
  net_amount  NUMERIC(12,2) NOT NULL,
  method      VARCHAR(20) NOT NULL DEFAULT 'mpesa', -- mpesa|bank
  destination VARCHAR(120) NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|approved|rejected
  reference   VARCHAR(80),
  admin_note  TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referrals (
  id              SERIAL PRIMARY KEY,
  referrer_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  level           INTEGER NOT NULL DEFAULT 1,
  commission      NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id      SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = broadcast to all
  title   VARCHAR(160) NOT NULL,
  message TEXT NOT NULL,
  type    VARCHAR(20) NOT NULL DEFAULT 'info',  -- info|success|warning|danger
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      VARCHAR(80) NOT NULL UNIQUE,
  type       VARCHAR(20) NOT NULL,  -- verify|reset
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(40) NOT NULL UNIQUE,
  amount      NUMERIC(10,2) NOT NULL,
  max_uses    INTEGER NOT NULL DEFAULT 100,
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id         SERIAL PRIMARY KEY,
  code_id    INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code_id, user_id)
);

CREATE TABLE IF NOT EXISTS achievements (
  id      SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge   VARCHAR(40) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, badge)
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject    VARCHAR(160) NOT NULL,
  status     VARCHAR(20) NOT NULL DEFAULT 'open', -- open|answered|closed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id         SERIAL PRIMARY KEY,
  ticket_id  INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_role VARCHAR(10) NOT NULL DEFAULT 'user',
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS announcements (
  id         SERIAL PRIMARY KEY,
  title      VARCHAR(160) NOT NULL,
  body       TEXT NOT NULL,
  banner_url TEXT,
  link       TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key   VARCHAR(60) PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS earnings_feed (
  id      SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name    VARCHAR(40),
  source  VARCHAR(40),
  amount  NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS live_chat_messages (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name       VARCHAR(60) NOT NULL DEFAULT 'Guest',
  role       VARCHAR(10) NOT NULL DEFAULT 'user',
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_referred_by   ON users(referred_by);
CREATE INDEX IF NOT EXISTS idx_tasks_status        ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tc_user_status      ON task_completions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tc_task             ON task_completions(task_id);
CREATE INDEX IF NOT EXISTS idx_deposits_user       ON deposits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user    ON withdrawals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user  ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer  ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_feed_created        ON earnings_feed(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_user        ON support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_ticket_msgs_ticket  ON ticket_messages(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_rewards_task   ON task_rewards(task_id);

-- Legacy deployments: add the newer columns if the tables already exist.
ALTER TABLE users ADD COLUMN IF NOT EXISTS country_code  VARCHAR(2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS currency      VARCHAR(10);
ALTER TABLE users ADD COLUMN IF NOT EXISTS currency_code VARCHAR(10);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS availability_type VARCHAR(20) NOT NULL DEFAULT 'global';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS countries TEXT;
ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS currency_code VARCHAR(10);
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS currency_code VARCHAR(10);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS currency_code VARCHAR(10);
