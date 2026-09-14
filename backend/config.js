const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  port: num(process.env.PORT, 3000),

  appUrl: (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),
  corsOrigins: (process.env.CORS_ORIGINS || process.env.APP_URL || '')
    .split(',').map((s) => s.trim()).filter(Boolean),

  jwtSecret: process.env.JWT_SECRET || 'taskcash-dev-secret-change-me',
  jwtExpires: '30d',
  csrfSecret: process.env.CSRF_SECRET || process.env.JWT_SECRET || 'taskcash-csrf-dev',

  db: {
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/taskcash',
    ssl: bool(process.env.DATABASE_SSL, false) ? { rejectUnauthorized: false } : false,
  },

  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@taskcash.co.ke',
    password: process.env.ADMIN_PASSWORD || 'Admin@1234',
    phone: process.env.ADMIN_PHONE || '0712345678',
  },

  mpesa: {
    env: process.env.MPESA_ENV || 'sandbox',
    key: process.env.MPESA_APP_KEY || '',
    secret: process.env.MPESA_APP_SECRET || '',
    shortcode: process.env.MPESA_SHORTCODE || '174379',
    passkey: process.env.MPESA_PASSKEY || '',
    callbackUrl: process.env.MPESA_CALLBACK_URL || '',
    baseUrl: (process.env.MPESA_BASE_URL || '').replace(/\/+$/, ''),
    get enabled() { return Boolean(this.key && this.secret); },
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'TaskCash Kenya <no-reply@taskcash.co.ke>',
  },

  wallet: {
    minWithdrawal: 100,
    withdrawalFeePct: 2,           // percent
    minDeposit: 50,
    withdrawalDailyLimit: 70000,
    referralL1Pct: 0.10,           // 10% of referred user's task earnings
    referralL2Pct: 0.03,           // 3% of team (level-2) task earnings
    signupBonus: 50,               // welcome bonus KES
    checkInBase: 5,                // day 1 of streak
    checkInCap: 25,                // streak cap
    withdrawReviewHours: 24,
  },

  // Demo mode auto-approves STK callbacks after 8s (no Daraja keys set)
  demoMode: !process.env.MPESA_APP_KEY,
};

module.exports = config;
