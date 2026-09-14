/**
 * Seed script — creates admin, demo users, packages, tasks, promos.
 * Run: npm run seed   (safe to re-run; skips existing rows)
 */
const bcrypt = require('bcryptjs');
const db = require('./index');
const config = require('../config');
const { Table } = require('./index');
const { referralCode } = require('../lib/helpers');
const { setTaskRewards } = require('../services/rewards');

const users = new Table('users');
const packages = new Table('packages');
const tasks = new Table('tasks');
const promos = new Table('promo_codes');

const PACKAGES = [
  { name: 'Starter',  price: 5,  daily_tasks: 6,  duration_days: 30, benefits: '6 daily tasks · Priority email support · Payouts' },
  { name: 'Silver',   price: 10, daily_tasks: 10, duration_days: 30, benefits: '10 daily tasks · Survey access · Referral bonus boost' },
  { name: 'Gold',     price: 25, daily_tasks: 18, duration_days: 30, benefits: '18 daily tasks · Video & app tasks · Priority verification' },
  { name: 'Platinum', price: 50, daily_tasks: 30, duration_days: 30, benefits: '30 daily tasks · All task types · Fast-track withdrawals' },
];

const TASKS = [
  { title: 'Watch: Mega deals promo', category: 'video', reward: 5, time_required: '30', verification_type: 'auto', url: 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ', instructions: 'Watch the sponsored video to the end, then claim your reward.', rewards: [{ country_code: 'KE', reward_amount: 500 }, { country_code: 'US', reward_amount: 5 }, { country_code: 'GB', reward_amount: 5 }, { country_code: 'NG', reward_amount: 5000 }, { country_code: 'TZ', reward_amount: 10000 }, { country_code: 'UG', reward_amount: 10000 }] },
  { title: 'Watch: 5G explainer', category: 'video', reward: 5, time_required: '45', verification_type: 'auto', url: 'https://www.youtube-nocookie.com/embed/ScMzIvxBSi4', instructions: 'Watch the sponsored video to the end, then claim your reward.' },
  { title: 'Survey: shopping habits', category: 'survey', reward: 2, time_required: '8 min', verification_type: 'code', instructions: 'Complete the survey and enter the code shown on the final "thank you" screen.', verification_code: 'THANKS1' },
  { title: 'Survey: Mobile money usage', category: 'survey', reward: 2, time_required: '6 min', verification_type: 'code', instructions: 'Answer all questions; the code appears on the last page.', verification_code: 'MONEY2', availability_type: 'countries', countries: ['KE', 'UG', 'TZ', 'NG', 'GH'] },
  { title: 'Visit & explore: travel blog', category: 'website', reward: 1, time_required: '2 min', verification_type: 'code', instructions: 'Visit the sponsor page, browse for 60s, then enter the code in the footer.', verification_code: 'SAFARI7' },
  { title: 'Follow & share our X post', category: 'social', reward: 3, time_required: '3 min', verification_type: 'screenshot', instructions: 'Follow @TaskCash, like + retweet the pinned post, upload a screenshot.' },
  { title: 'Instagram story shoutout', category: 'social', reward: 3, time_required: '5 min', verification_type: 'screenshot', instructions: 'Share our banner on your IG story (keep it 24h) and upload proof.' },
  { title: 'Download & open the news app', category: 'app', reward: 5, time_required: '5 min', verification_type: 'code', instructions: 'Install the sponsor app from your app store, open it once, enter the code from the welcome screen.', verification_code: 'APP2024' },
  { title: 'Affiliate: sign up for the marketplace newsletter', category: 'affiliate', reward: 4, time_required: '4 min', verification_type: 'manual', instructions: 'Register through our partner link; approval after partner confirmation.' },
  { title: 'Refer a friend to TaskCash', category: 'referral', reward: 10, time_required: '—', verification_type: 'manual', instructions: 'Invite a friend with your code. Reward paid after their first completed task.' },
  { title: 'Daily check-in', category: 'checkin', reward: 1, time_required: '10s', verification_type: 'auto', instructions: 'Open the app every day to keep your streak alive. Streaks grow your bonus.' },
];

async function exists(table, where) {
  const t = new Table(table);
  return Boolean(await t.get(where));
}

async function main() {
  await db.init();

  // Admin
  if (!(await exists('users', { email: config.admin.email.toLowerCase() }))) {
    await users.create({
      fullname: 'TaskCash Admin', username: 'admin', email: config.admin.email.toLowerCase(),
      phone: config.admin.phone, country: 'Kenya', country_code: 'KE', currency: 'KES', currency_code: 'KES',
      password_hash: await bcrypt.hash(config.admin.password, 12),
      role: 'admin', status: 'active', email_verified: true, kyc_status: 'verified',
      referral_code: referralCode('AD'),
    });
    console.log('✔ admin created:', config.admin.email);
  } else {
    console.log('• admin exists');
  }

  // Demo users (1 referrer + 2 referred, to demo the referral tree)
  const demoPassword = await bcrypt.hash('Demo@1234', 12);
  let referrer;
  if (!(await exists('users', { username: 'wanjiku' }))) {
    referrer = await users.create({
      fullname: 'Grace Wanjiku', username: 'wanjiku', email: 'wanjiku@demo.test',
      phone: '254712345678', country: 'Kenya', country_code: 'KE', currency: 'KES', currency_code: 'KES',
      password_hash: demoPassword,
      role: 'user', status: 'active', email_verified: true, kyc_status: 'verified',
      referral_code: referralCode('GR'), balance: 1250, total_earned: 2480, tasks_completed: 42,
    });
    console.log('✔ demo user wanjiku (password Demo@1234)');
  } else {
    referrer = await users.get({ username: 'wanjiku' });
  }
  const referredNames = [
    ['Brian Otieno', 'brian', '254723456789', 'br@demo.test'],
    ['Achieng Nyala', 'achieng', '254734567890', 'ac@demo.test'],
  ];
  for (const [fullname, username, phone, email] of referredNames) {
    if (!(await exists('users', { username }))) {
      const u = await users.create({
        fullname, username, email, phone, country: 'Kenya', country_code: 'KE', currency: 'KES', currency_code: 'KES',
        password_hash: demoPassword, role: 'user', status: 'active', email_verified: true,
        referral_code: referralCode(username), referred_by: referrer.id,
        balance: 180, total_earned: 320, tasks_completed: 9,
      });
      await new Table('referrals').create({ referrer_id: referrer.id, referred_user_id: u.id, level: 1, commission: 0 });
      console.log(`✔ demo user ${username} (referred by wanjiku)`);
    }
  }

  // Packages (prices are in each account's own currency — no FX involved)
  for (const p of PACKAGES) {
    if (!(await exists('packages', { name: p.name }))) {
      await packages.create(p);
      console.log(`✔ package ${p.name}`);
    }
  }

  // Tasks + per-country rewards
  for (const t of TASKS) {
    if (!(await exists('tasks', { title: t.title }))) {
      const { rewards, countries, availability_type, ...row } = t;
      const created = await tasks.create({
        ...row,
        availability_type: availability_type || 'global',
        countries: countries ? JSON.stringify(countries) : '[]',
        status: 'active',
      });
      if (rewards && rewards.length) await setTaskRewards(created.id, rewards);
      console.log(`✔ task: ${t.title}${rewards ? ` (${rewards.length} country rewards)` : ''}`);
    }
  }

  // Promos (KES-denominated; legacy promo budget)
  if (!(await exists('promo_codes', { code: 'KARIBU' }))) {
    await promos.create({ code: 'KARIBU', amount: 50, currency_code: 'KES', max_uses: 1000 });
    console.log('✔ promo code KARIBU (50 KES)');
  }
  if (!(await exists('promo_codes', { code: 'TASH25' }))) {
    await promos.create({ code: 'TASH25', amount: 25, currency_code: 'KES', max_uses: 500 });
    console.log('✔ promo code TASH25 (25 KES)');
  }

  // Announcements
  if (!(await exists('announcements', { title: 'Welcome to TaskCash' }))) {
    await new Table('announcements').create({
      title: 'Welcome to TaskCash',
      body: 'Complete tasks, invite friends and cash out. Earnings come from completed tasks, referrals and sponsored activities — never from investments.',
    });
  }

  console.log('\nSeed complete. Admin login with ADMIN_EMAIL/ADMIN_PASSWORD from .env');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
