/**
 * Seed script — admin account, demo user, Watch & Earn videos and settings.
 * Run: npm run seed   (safe to re-run; skips existing rows)
 *
 * No balances are fabricated here: every account starts at KES 0.00 and only
 * verified watch rewards, verified deposits or published referral rules can
 * move money.
 */
const bcrypt = require('bcryptjs');
const db = require('./index');
const { Table } = require('./index');
const config = require('../config');
const { referralCode } = require('../lib/helpers');
const settings = require('../services/settings');

const users = new Table('users');
const videos = new Table('videos');

const VIDEOS = [
  {
    title: 'Daily Video — Mobile Money Safety',
    description: 'Learn how to protect your M-Pesa PIN and spot common mobile money scams.',
    video_url: 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ',
    duration_seconds: 90,
    reward: 5,
    daily_limit: 1,
  },
  {
    title: 'Sponsored — Nourish Foods Cooking Challenge',
    description: 'Watch the sponsored cooking challenge and earn a verified reward.',
    video_url: 'https://www.youtube-nocookie.com/embed/eRsGyueVLvQ',
    duration_seconds: 120,
    reward: 6,
    daily_limit: 1,
  },
  {
    title: 'Daily Video — Airtime & Data Bundles Explained',
    description: 'A short explainer on choosing the right bundle for your usage.',
    video_url: 'https://www.youtube-nocookie.com/embed/R6MlUcmOul8',
    duration_seconds: 105,
    reward: 5,
    daily_limit: 1,
  },
  {
    title: 'Sponsored — Nyumbani Furniture Showcase',
    description: 'Take a tour of the new season collection from our sponsor.',
    video_url: 'https://www.youtube-nocookie.com/embed/TLkA0RELQ1g',
    duration_seconds: 75,
    reward: 4,
    daily_limit: 2,
  },
  {
    title: 'Daily Video — Kenya’s Renewable Energy Story',
    description: 'How geothermal and wind power are changing the grid.',
    video_url: 'https://www.youtube-nocookie.com/embed/Y-rmzh0PI3c',
    duration_seconds: 150,
    reward: 7,
    daily_limit: 1,
  },
  {
    title: 'Bonus Video — Weekend Sports Roundup',
    description: 'Highlights from the weekend fixtures. Limited to once a day.',
    video_url: 'https://www.youtube-nocookie.com/embed/ScMzIvxBSi4',
    duration_seconds: 180,
    reward: 10,
    daily_limit: 1,
  },
];

async function exists(table, where) {
  return Boolean(await new Table(table).get(where));
}

async function main() {
  await db.init();

  // ── Admin ────────────────────────────────────────────────
  if (!(await exists('users', { email: config.admin.email.toLowerCase() }))) {
    await users.create({
      fullname: 'WATCHREWARDS Admin',
      username: 'admin',
      email: config.admin.email.toLowerCase(),
      phone: String(config.admin.phone).replace(/\D/g, '').replace(/^0/, '254'),
      payout_phone: String(config.admin.phone).replace(/\D/g, '').replace(/^0/, '254'),
      password_hash: await bcrypt.hash(config.admin.password, 12),
      role: 'admin',
      status: 'active',
      email_verified: true,
      referral_code: referralCode('AD'),
      currency_code: config.wallet.currency,
      balance: 0, pending_balance: 0, total_earned: 0, total_deposited: 0, total_withdrawn: 0,
    });
    console.log('✔ admin created:', config.admin.email);
  } else {
    console.log('• admin exists');
  }

  // ── Demo user (kept on a different number from the admin account) ──
  if (!(await exists('users', { phone: '254799000001' }))) {
    await users.create({
      fullname: 'Grace Wanjiku',
      username: 'wanjiku',
      email: 'wanjiku@demo.test',
      phone: '254799000001',
      payout_phone: '254799000001',
      password_hash: await bcrypt.hash('Demo@1234', 12),
      role: 'user',
      status: 'active',
      email_verified: true,
      referral_code: referralCode('GR'),
      currency_code: config.wallet.currency,
      balance: 0, pending_balance: 0, total_earned: 0, total_deposited: 0, total_withdrawn: 0,
    });
    console.log('✔ demo user 0799000001 / Demo@1234');
  } else {
    console.log('• demo user exists');
  }

  // ── Videos ───────────────────────────────────────────────
  for (const v of VIDEOS) {
    if (!(await exists('videos', { title: v.title }))) {
      await videos.create({
        ...v,
        currency_code: config.wallet.currency,
        status: 'active',
      });
      console.log(`✔ video: ${v.title} (${v.duration_seconds}s · KES ${v.reward})`);
    }
  }

  // ── Settings (operator editable from the admin console) ──
  const { applied } = await settings.update({
    brand_name: config.brand,
    min_withdrawal: config.wallet.minWithdrawal,
    withdrawal_fee_pct: config.wallet.withdrawalFeePct,
    expected_processing: config.wallet.expectedProcessing,
    min_deposit: config.payments.minDeposit,
    max_deposit: config.payments.maxDeposit,
    watch_daily_limit: config.watch.dailyLimit,
    watch_required_pct: config.watch.requiredPct,
    referral_reward: config.watch.referralReward,
    referral_rules: settings.DEFAULTS.referral_rules,
  });
  console.log(`✔ settings written (${Object.keys(applied).length} keys)`);

  console.log('\nSeed complete. Admin login uses ADMIN_EMAIL / ADMIN_PASSWORD from .env');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
