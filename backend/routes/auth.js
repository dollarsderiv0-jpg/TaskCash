const express = require('express');
const bcrypt = require('bcryptjs');
const { Table } = require('../db');
const config = require('../config');
const { wrap, referralCode, token, isValidKenyanPhone } = require('../lib/helpers');
const { sign, requireAuth, issueCsrf } = require('../middleware/auth');
const { sendVerificationMail, sendResetMail } = require('../services/mailer');
const kyc = require('../services/kyc');

const router = express.Router();
const users = new Table('users');
const emailTokens = new Table('email_tokens');
const referrals = new Table('referrals');
const notifications = new Table('notifications');

const publicUser = (u) => ({
  id: u.id, fullname: u.fullname, username: u.username, email: u.email,
  phone: u.phone, country: u.country, role: u.role, status: u.status,
  email_verified: u.email_verified, kyc_status: u.kyc_status,
  referral_code: u.referral_code, referred_by: u.referred_by,
  balance: Number(u.balance || 0), pending_balance: Number(u.pending_balance || 0),
  total_earned: Number(u.total_earned || 0), referral_earnings: Number(u.referral_earnings || 0),
  package_id: u.package_id, package_expires: u.package_expires,
  checkin_streak: u.checkin_streak || 0, tasks_completed: u.tasks_completed || 0,
  avatar: u.avatar || null, created_at: u.created_at,
});

function usernameValid(u) { return /^[a-zA-Z0-9_]{3,20}$/.test(u); }
function emailValid(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }
function passwordStrong(p) { return typeof p === 'string' && p.length >= 8 && /[a-zA-Z]/.test(p) && /\d/.test(p); }

async function issueVerifyToken(user) {
  const t = token(24);
  await emailTokens.create({
    user_id: user.id, token: t, type: 'verify',
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  });
  return `${config.appUrl}/verify-email.html?token=${t}`;
}

// ── Register ──────────────────────────────────────────────
router.post('/register', wrap(async (req, res) => {
  const { fullname, username, email, phone, country, password, ref_code } = req.body || {};

  if (!fullname || String(fullname).trim().length < 3) return res.status(400).json({ error: 'Full name is required' });
  if (!usernameValid(username || '')) return res.status(400).json({ error: 'Username must be 3–20 letters, numbers or underscore' });
  if (!emailValid(email || '')) return res.status(400).json({ error: 'Valid email required' });
  if (!isValidKenyanPhone(phone)) return res.status(400).json({ error: 'Enter a valid Kenyan phone number (07XX or 2547XX…)' });
  if (!passwordStrong(password)) return res.status(400).json({ error: 'Password needs 8+ chars with letters and numbers' });

  const uname = String(username).toLowerCase();
  const mail = String(email).toLowerCase().trim();

  if (await users.get({ username: uname })) return res.status(409).json({ error: 'Username already taken' });
  if (await users.get({ email: mail })) return res.status(409).json({ error: 'Email already registered' });

  // Referral
  let referrer = null;
  if (ref_code) {
    referrer = await users.get({ referral_code: String(ref_code).trim().toUpperCase() });
    if (!referrer) return res.status(400).json({ error: 'Invalid referral code' });
  }

  const password_hash = await bcrypt.hash(password, 12);
  let user;
  try {
    user = await users.create({
      fullname: String(fullname).trim().slice(0, 120),
      username: uname,
      email: mail,
      phone: String(phone).trim(),
      country: String(country || 'Kenya').slice(0, 60),
      password_hash,
      role: 'user',
      referral_code: referralCode(uname),
      referred_by: referrer ? referrer.id : null,
      balance: config.wallet.signupBonus, // welcome bonus (from platform promo budget)
      signup_bonus: config.wallet.signupBonus,
    });
  } catch (e) {
    if (e.friendly === 'email') return res.status(409).json({ error: 'Email already registered' });
    if (e.friendly === 'username') return res.status(409).json({ error: 'Username already taken' });
    if (e.code === '23505') return res.status(409).json({ error: 'Account already exists' });
    throw e;
  }

  if (referrer) {
    await referrals.create({ referrer_id: referrer.id, referred_user_id: user.id, level: 1, commission: 0 });
    if (referrer.referred_by) {
      await referrals.create({ referrer_id: referrer.referred_by, referred_user_id: user.id, level: 2, commission: 0 });
    }
    await notifications.create({
      user_id: referrer.id, type: 'success',
      title: 'New referral!',
      message: `${user.username} joined using your code.`,
    });
  }

  await notifications.create({
    user_id: user.id, type: 'info', title: 'Welcome to TaskCash Kenya 🎉',
    message: `You received a KES ${config.wallet.signupBonus} welcome bonus. Complete tasks to grow your balance — earnings come from tasks, referrals and sponsored activities, not investments.`,
  });

  const verifyUrl = await issueVerifyToken(user);
  await sendVerificationMail(user, verifyUrl);

  const jwt = sign(user);
  const csrf = issueCsrf(res);
  res.cookie('taskcash_token', jwt, {
    httpOnly: true, sameSite: 'strict', secure: config.isProd,
    maxAge: 30 * 24 * 3600 * 1000,
  });

  res.status(201).json({
    user: publicUser(user),
    token: jwt,
    csrf,
    verify_url: config.isProd ? undefined : verifyUrl, // surfaced only outside production
  });
}));

// ── Login ─────────────────────────────────────────────────
router.post('/login', wrap(async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ error: 'Enter your email/username and password' });

  const idf = String(identifier).toLowerCase().trim();
  const user = (await users.get({ email: idf })) || (await users.get({ username: idf }));
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Contact support.' });

  await users.update(user.id, { last_login: new Date().toISOString() });
  const jwt = sign(user);
  const csrf = issueCsrf(res);
  res.cookie('taskcash_token', jwt, {
    httpOnly: true, sameSite: 'strict', secure: config.isProd,
    maxAge: 30 * 24 * 3600 * 1000,
  });
  res.json({ user: publicUser(user), token: jwt, csrf });
}));

// ── Logout ────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('taskcash_token');
  res.json({ ok: true });
});

// ── Me ────────────────────────────────────────────────────
router.get('/me', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
}));

// ── Email verification ────────────────────────────────────
router.get('/verify-email', wrap(async (req, res) => {
  const { token: t } = req.query;
  if (!t) return res.status(400).json({ error: 'Token required' });
  const row = await emailTokens.get({ token: String(t), type: 'verify' });
  if (!row || row.used) return res.status(400).json({ error: 'Invalid or already-used link' });
  if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Link expired' });

  await emailTokens.update(row.id, { used: true });
  await users.update(row.user_id, { email_verified: true });
  res.json({ ok: true, message: 'Email verified. Karibu TaskCash! 🎉' });
}));

router.post('/resend-verification', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.email_verified) return res.json({ ok: true, message: 'Already verified' });
  const url = await issueVerifyToken(user);
  await sendVerificationMail(user, url);
  res.json({ ok: true, message: 'Verification email sent', verify_url: config.isProd ? undefined : url });
}));

// ── Forgot / reset password ───────────────────────────────
router.post('/forgot-password', wrap(async (req, res) => {
  const { email } = req.body || {};
  const user = email ? await users.get({ email: String(email).toLowerCase().trim() }) : null;
  if (user) {
    const t = token(24);
    await emailTokens.create({
      user_id: user.id, token: t, type: 'reset',
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
    const url = `${config.appUrl}/reset-password.html?token=${t}`;
    await sendResetMail(user, url);
    if (!config.isProd) return res.json({ ok: true, message: 'Reset link sent', reset_url: url });
  }
  // Always same response (no account enumeration)
  res.json({ ok: true, message: 'If that email exists, a reset link has been sent' });
}));

router.post('/reset-password', wrap(async (req, res) => {
  const { token: t, password } = req.body || {};
  if (!t || !passwordStrong(password)) {
    return res.status(400).json({ error: 'Valid token and strong password required (8+ chars, letters & numbers)' });
  }
  const row = await emailTokens.get({ token: String(t), type: 'reset' });
  if (!row || row.used) return res.status(400).json({ error: 'Invalid or used reset link' });
  if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Reset link expired' });

  await emailTokens.update(row.id, { used: true });
  await users.update(row.user_id, { password_hash: await bcrypt.hash(password, 12) });
  res.json({ ok: true, message: 'Password updated. You can now log in.' });
}));

// ── Change password (logged in) ───────────────────────────
router.post('/change-password', requireAuth, wrap(async (req, res) => {
  const { current, next } = req.body || {};
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!(await bcrypt.compare(current || '', user.password_hash))) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (!passwordStrong(next)) return res.status(400).json({ error: 'New password needs 8+ chars with letters and numbers' });
  await users.update(user.id, { password_hash: await bcrypt.hash(next, 12) });
  res.json({ ok: true, message: 'Password changed' });
}));

// ── Profile settings ──────────────────────────────────────
router.put('/profile', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const patch = {};
  if (req.body.fullname) patch.fullname = String(req.body.fullname).trim().slice(0, 120);
  if (req.body.phone) {
    if (!isValidKenyanPhone(req.body.phone)) return res.status(400).json({ error: 'Invalid Kenyan phone number' });
    patch.phone = String(req.body.phone).trim();
  }
  if (req.body.country) patch.country = String(req.body.country).slice(0, 60);
  if (req.body.avatar !== undefined) patch.avatar = String(req.body.avatar || '').slice(0, 500000) || null;
  if (Object.keys(patch).length) await users.update(user.id, patch);
  res.json({ user: publicUser(await users.byId(user.id)) });
}));

// ── KYC / account verification ────────────────────────────
router.post('/kyc', requireAuth, wrap(async (req, res) => {
  try {
    const result = await kyc.submit(req.user.id, req.body || {});
    res.json({ ok: true, ...result, message: 'Documents received — review usually within 24h' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

router.get('/kyc', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  res.json({ kyc_status: user ? user.kyc_status : 'unverified' });
}));

module.exports = router;
