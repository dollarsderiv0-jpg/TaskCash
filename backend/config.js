const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

const config = {
  brand: 'WATCHREWARDS',
  tagline: 'WATCH • EARN • WITHDRAW',
  env: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  port: num(process.env.PORT, 3000),

  appUrl: (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),
  corsOrigins: (process.env.CORS_ORIGINS || process.env.APP_URL || '')
    .split(',').map((s) => s.trim()).filter(Boolean),

  jwtSecret: process.env.JWT_SECRET || 'watchrewards-dev-secret-change-me',
  jwtExpires: '30d',
  csrfSecret: process.env.CSRF_SECRET || process.env.JWT_SECRET || 'watchrewards-csrf-dev',

  db: {
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/watchrewards',
    ssl: bool(process.env.DATABASE_SSL, false) ? { rejectUnauthorized: false } : false,
  },

  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@watchrewards.app',
    password: process.env.ADMIN_PASSWORD || 'Admin@1234',
    phone: process.env.ADMIN_PHONE || '0712345678',
  },

  // Watch & Earn rules. Session completion is validated server-side against
  // these values — the client can never claim a reward on its own.
  watch: {
    dailyLimit: num(process.env.WATCH_DAILY_LIMIT, 5),
    requiredPct: num(process.env.WATCH_REQUIRED_PCT, 0.9),
    minSessionSeconds: num(process.env.WATCH_MIN_SECONDS, 10),
    maxSessionSeconds: num(process.env.WATCH_MAX_SESSION_SECONDS, 3600),
    referralReward: num(process.env.REFERRAL_REWARD, 20),
  },

  mpesa: {
    env: process.env.MPESA_ENV || 'sandbox',
    key: process.env.MPESA_APP_KEY || '',
    secret: process.env.MPESA_APP_SECRET || '',
    shortcode: process.env.MPESA_SHORTCODE || '174379',
    passkey: process.env.MPESA_PASSKEY || '',
    callbackUrl: process.env.MPESA_CALLBACK_URL || '',
    baseUrl: (process.env.MPESA_BASE_URL || '').replace(/\/+$/, ''),
    // Payouts (B2C) need their own shortcode + initiator, separate from the
    // collection (C2B / STK) shortcode above.
    b2c: {
      shortcode: process.env.MPESA_B2C_SHORTCODE || '',
      initiatorName: process.env.MPESA_B2C_INITIATOR || '',
      securityCredential: process.env.MPESA_B2C_SECURITY_CREDENTIAL || '',
      commandId: process.env.MPESA_B2C_COMMAND_ID || 'BusinessPayment',
      resultUrl: process.env.MPESA_B2C_RESULT_URL || '',
      timeoutUrl: process.env.MPESA_B2C_TIMEOUT_URL || '',
      get enabled() {
        return Boolean(this.shortcode && this.initiatorName && this.securityCredential);
      },
    },
    get enabled() { return Boolean(this.key && this.secret); },
  },

  // ── Payment abstraction layer ────────────────────────────
  // 'mpesa' (Daraja) is the only live provider. Anything else is a sandbox
  // used for development and is refused outright in production.
  payments: {
    provider: (process.env.PAYMENT_PROVIDER || 'mpesa').toLowerCase(),
    mode: (process.env.PAYMENT_MODE || ((process.env.NODE_ENV || 'development') === 'production' ? 'live' : 'sandbox')).toLowerCase(),
    accountRef: process.env.PAYMENT_ACCOUNT_REF || 'WATCHREWARDS',
    currency: process.env.PAYMENT_CURRENCY || 'KES',
    minDeposit: num(process.env.MIN_DEPOSIT, 10),
    maxDeposit: num(process.env.MAX_DEPOSIT, 150000),
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'WATCHREWARDS <no-reply@watchrewards.app>',
  },

  wallet: {
    currency: 'KES',
    minWithdrawal: num(process.env.MIN_WITHDRAWAL, 150),
    withdrawalFeePct: num(process.env.WITHDRAWAL_FEE_PCT, 2), // percent
    expectedProcessing: process.env.EXPECTED_PROCESSING || 'Within 24 hours',
    minDeposit: num(process.env.MIN_DEPOSIT, 10),
    withdrawalDailyLimit: num(process.env.WITHDRAWAL_DAILY_LIMIT, 70000),
    referralL1Pct: 0.10,           // 10% of referred user's task earnings
    referralL2Pct: 0.03,           // 3% of team (level-2) task earnings
    signupBonus: 50,               // welcome bonus KES
    checkInBase: 5,                // day 1 of streak
    checkInCap: 25,                // streak cap
    withdrawReviewHours: 24,
  },

  // Sandbox = no live Daraja credentials. Sandbox transactions are recorded
  // as PENDING only; they are never presented as real M-Pesa payments and all
  // simulation helpers hard-fail when NODE_ENV=production.
  sandboxMode: !process.env.MPESA_APP_KEY || (process.env.PAYMENT_MODE || '').toLowerCase() === 'sandbox',
};

module.exports = config;
