/**
 * Authentication (sections 02, 03) + profile & security (sections 17 – 20).
 *
 * - Login is phone number + password.
 * - Passwords are hashed with bcrypt (never stored or logged in plain text).
 * - Changing the account phone or the M-Pesa payout number requires
 *   re-authentication with the account password, is written to the audit log
 *   and notifies the user.
 * - "Logout all devices" revokes every session row, so old tokens stop working.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Table } = require('../db');
const config = require('../config');
const {
  wrap, referralCode, token, toMpesaFormat, isValidKenyanPhone, displayKenyanPhone, maskPhone, txnRef,
} = require('../lib/helpers');
const {
  sign, requireAuth, issueCsrf, setSessionCookies, clearSessionCookies,
} = require('../middleware/auth');
const { sendResetMail } = require('../services/mailer');
const notify = require('../services/notify');
const ledger = require('../services/ledger');
const settings = require('../services/settings');

const router = express.Router();
const users = new Table('users');
const sessions = new Table('login_sessions');
const emailTokens = new Table('email_tokens');
const referrals = new Table('referrals');

const emailValid = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || ''));
const passwordStrong = (p) => typeof p === 'string' && p.length >= 8 && /[a-zA-Z]/.test(p) && /\d/.test(p);
const usernameValid = (u) => /^[a-zA-Z0-9_]{3,20}$/.test(String(u || ''));

/** Public shape of a user. The M-Pesa number is always shown masked. */
const publicUser = (u) => ({
  id: u.id,
  fullname: u.fullname,
  username: u.username,
  email: u.email,
  phone: displayKenyanPhone(u.phone),
  payout_phone: u.payout_phone ? maskPhone(u.payout_phone) : null,
  payout_phone_set: Boolean(u.payout_phone),
  role: u.role,
  status: u.status,
  currency_code: u.currency_code || config.wallet.currency,
  referral_code: u.referral_code,
  balance: Number(u.balance || 0),
  pending_balance: Number(u.pending_balance || 0),
  total_earned: Number(u.total_earned || 0),
  total_deposited: Number(u.total_deposited || 0),
  total_withdrawn: Number(u.total_withdrawn || 0),
  referral_earnings: Number(u.referral_earnings || 0),
  watched_count: Number(u.watched_count || 0),
  email_verified: Boolean(u.email_verified),
  created_at: u.created_at,
});

/** Derives a unique username (the spec's registration form has no username). */
async function deriveUsername(phone) {
  const base = `wr${String(toMpesaFormat(phone)).slice(-6)}`;
  for (let i = 0; i < 6; i += 1) {
    const candidate = i === 0 ? base : `${base}${crypto.randomInt(10, 99)}`;
    if (usernameValid(candidate) && !(await users.get({ username: candidate }))) return candidate;
  }
  return `wr${crypto.randomBytes(4).toString('hex')}`;
}

async function openSession(user, req, res) {
  const sessionId = txnRef('S-');
  await sessions.create({
    session_id: sessionId,
    user_id: Number(user.id),
    ip: req.ip ? String(req.ip).slice(0, 60) : null,
    user_agent: req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 300) : null,
    last_seen_at: new Date().toISOString(),
  });
  const jwtToken = sign(user, sessionId);
  const csrf = issueCsrf(res);
  setSessionCookies(res, jwtToken, csrf);
  return { token: jwtToken, csrf, sessionId };
}

// ── Register (section 03) ───────────────────────────────────
router.post('/register', wrap(async (req, res) => {
  const {
    fullname, phone, email, password, confirm_password: confirmPassword,
    referral_code: refCode, terms,
  } = req.body || {};

  const errors = {};
  if (!fullname || String(fullname).trim().length < 3) errors.fullname = 'Enter your full name';
  if (!isValidKenyanPhone(phone)) errors.phone = 'Enter a valid Kenyan phone number (07XXXXXXXX)';
  if (!emailValid(email)) errors.email = 'Enter a valid email address';
  if (!passwordStrong(password)) errors.password = 'Use 8+ characters with letters and numbers';
  if (confirmPassword !== undefined && password !== confirmPassword) errors.confirm_password = 'Passwords do not match';
  if (!terms) errors.terms = 'Please accept the Terms & Conditions and Privacy Policy';

  if (Object.keys(errors).length) {
    return res.status(400).json({ error: Object.values(errors)[0], errors });
  }

  const phoneNorm = toMpesaFormat(phone);
  const mail = String(email).toLowerCase().trim();

  // Duplicate phone registrations are rejected outright.
  if (await users.get({ phone: phoneNorm })) {
    return res.status(409).json({ error: 'That phone number is already registered', errors: { phone: 'Already registered' } });
  }
  if (await users.get({ email: mail })) {
    return res.status(409).json({ error: 'That email is already registered', errors: { email: 'Already registered' } });
  }

  let referrer = null;
  if (refCode) {
    const code = String(refCode).trim().toUpperCase();
    referrer = await users.get({ referral_code: code });
    if (!referrer) return res.status(400).json({ error: 'Invalid referral code', errors: { referral_code: 'Invalid referral code' } });
  }

  const username = await deriveUsername(phoneNorm);
  const passwordHash = await bcrypt.hash(password, 12);

  let user;
  try {
    user = await users.create({
      fullname: String(fullname).trim().slice(0, 120),
      username,
      email: mail,
      phone: phoneNorm,
      payout_phone: phoneNorm,
      password_hash: passwordHash,
      role: 'user',
      status: 'active',
      email_verified: false,
      referred_by: referrer ? referrer.id : null,
      balance: 0,               // balance starts at 0 — no unexplained credits
      pending_balance: 0,
      total_earned: 0,
      total_deposited: 0,
      total_withdrawn: 0,
      referral_code: referralCode(username),
      currency_code: config.wallet.currency,
    });
  } catch (e) {
    if (e.friendly === 'email' || e.code === '23505') {
      return res.status(409).json({ error: 'An account with those details already exists' });
    }
    throw e;
  }

  if (referrer) {
    await referrals.create({
      referrer_id: referrer.id,
      referred_user_id: user.id,
      level: 1,
      commission: 0,
    });
    await notify.push(referrer.id, {
      title: 'New team member',
      message: 'Someone registered with your referral code. Referral rewards are credited once they complete an eligible watch task.',
      type: 'info',
      link: '#/team',
    });
  }

  await notify.push(user.id, {
    title: `Welcome to ${config.brand} 🎉`,
    message: `Your account is ready. Watch eligible videos to earn rewards — payouts are sent to your M-Pesa number after verification.`,
    type: 'success',
    link: '#/watch',
  });

  const session = await openSession(user, req, res);
  await ledger.audit({ actorId: user.id, actorRole: 'user', action: 'auth.register', targetType: 'user', targetId: user.id });

  res.status(201).json({
    user: publicUser(user),
    ...session,
    message: 'Account created',
  });
}));

// ── Login (section 02) ──────────────────────────────────────
router.post('/login', wrap(async (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) {
    return res.status(400).json({ error: 'Enter your phone number and password' });
  }

  const raw = String(phone).trim();
  const norm = toMpesaFormat(raw);
  const user = (await users.get({ phone: norm }))
    || (await users.get({ phone: raw }))
    || (await users.get({ email: raw.toLowerCase() }));

  if (!user) return res.status(401).json({ error: 'Invalid phone number or password' });

  const ok = await bcrypt.compare(String(password), user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid phone number or password' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Please contact support.' });

  await users.update(user.id, { last_login: new Date().toISOString() });
  const session = await openSession(user, req, res);
  res.json({ user: publicUser(user), ...session });
}));

// ── Logout ──────────────────────────────────────────────────
router.post('/logout', wrap(async (req, res) => {
  const header = req.headers.authorization;
  const tokenValue = (header && header.startsWith('Bearer ') ? header.slice(7) : null)
    || (req.cookies && req.cookies.wr_token);
  if (tokenValue) {
    try {
      const payload = require('jsonwebtoken').verify(tokenValue, config.jwtSecret);
      if (payload.sid) {
        const row = await sessions.get({ session_id: payload.sid });
        if (row) await sessions.update(row.id, { revoked: true });
      }
    } catch { /* already invalid */ }
  }
  clearSessionCookies(res);
  res.json({ ok: true });
}));

router.get('/me', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user), config: await settings.publicConfig() });
}));

// ── Password reset ──────────────────────────────────────────
router.post('/forgot-password', wrap(async (req, res) => {
  const identifier = String(req.body.phone || req.body.email || '').trim();
  const user = identifier
    ? (await users.get({ email: identifier.toLowerCase() })) || (await users.get({ phone: toMpesaFormat(identifier) }))
    : null;

  if (user) {
    const t = token(24);
    await emailTokens.create({
      user_id: user.id,
      token: t,
      type: 'reset',
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
    const url = `${config.appUrl}/#/reset-password?token=${t}`;
    await sendResetMail(user, url);
    if (!config.isProd) return res.json({ ok: true, message: 'Reset link sent', reset_url: url });
  }
  // Always the same response: no account enumeration.
  res.json({ ok: true, message: 'If that account exists, a reset link has been sent' });
}));

router.post('/reset-password', wrap(async (req, res) => {
  const { token: t, password, confirm_password: confirmPassword } = req.body || {};
  if (!passwordStrong(password)) {
    return res.status(400).json({ error: 'Use 8+ characters with letters and numbers' });
  }
  if (confirmPassword !== undefined && password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }
  const row = await emailTokens.get({ token: String(t || ''), type: 'reset' });
  if (!row || row.used) return res.status(400).json({ error: 'Invalid or already-used reset link' });
  if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Reset link expired' });

  await emailTokens.update(row.id, { used: true });
  await users.update(row.user_id, { password_hash: await bcrypt.hash(password, 12) });
  // Any existing session is revoked after a password reset.
  const mine = await sessions.all({ where: { user_id: Number(row.user_id) }, limit: 200 });
  for (const s of mine) await sessions.update(s.id, { revoked: true });
  await ledger.audit({ actorId: row.user_id, actorRole: 'user', action: 'auth.password_reset', targetType: 'user', targetId: row.user_id });
  res.json({ ok: true, message: 'Password updated. Please sign in.' });
}));

// ── Change password (section 20) ────────────────────────────
router.post('/change-password', requireAuth, wrap(async (req, res) => {
  const { current_password: current, new_password: next, confirm_password: confirm } = req.body || {};
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!(await bcrypt.compare(String(current || ''), user.password_hash))) {
    return res.status(401).json({ error: 'Your current password is incorrect', errors: { current_password: 'Incorrect password' } });
  }
  if (!passwordStrong(next)) return res.status(400).json({ error: 'Use 8+ characters with letters and numbers', errors: { new_password: 'Too weak' } });
  if (confirm !== undefined && next !== confirm) return res.status(400).json({ error: 'Passwords do not match' });

  await users.update(user.id, { password_hash: await bcrypt.hash(next, 12) });
  await notify.push(user.id, { title: 'Password changed', message: 'Your password was updated successfully.', type: 'success' });
  await ledger.audit({ actorId: user.id, actorRole: 'user', action: 'auth.password_changed', targetType: 'user', targetId: user.id });
  res.json({ ok: true, message: 'Password changed' });
}));

// ── Personal information (section 18) ───────────────────────
router.get('/profile', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
}));

router.put('/profile', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const patch = {};
  if (req.body.fullname !== undefined) {
    if (String(req.body.fullname).trim().length < 3) return res.status(400).json({ error: 'Enter your full name', errors: { fullname: 'Too short' } });
    patch.fullname = String(req.body.fullname).trim().slice(0, 120);
  }
  if (req.body.email !== undefined) {
    const mail = String(req.body.email).toLowerCase().trim();
    if (!emailValid(mail)) return res.status(400).json({ error: 'Enter a valid email address', errors: { email: 'Invalid email' } });
    const clash = await users.get({ email: mail });
    if (clash && Number(clash.id) !== Number(user.id)) {
      return res.status(409).json({ error: 'That email is already in use', errors: { email: 'Already registered' } });
    }
    patch.email = mail;
    patch.email_verified = false;
  }

  if (!Object.keys(patch).length) return res.json({ user: publicUser(user) });
  await users.update(user.id, patch);
  await ledger.audit({ actorId: user.id, actorRole: 'user', action: 'profile.updated', targetType: 'user', targetId: user.id, detail: Object.keys(patch).join(',') });
  res.json({ user: publicUser(await users.byId(user.id)), message: 'Changes saved' });
}));

/**
 * Account phone change (section 18). Requires the account password, so a
 * stolen session alone cannot move the account's login identity.
 */
router.post('/phone', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { phone, password } = req.body || {};

  if (!(await bcrypt.compare(String(password || ''), user.password_hash))) {
    return res.status(401).json({ error: 'Enter your account password to verify this change', errors: { password: 'Incorrect password' } });
  }
  if (!isValidKenyanPhone(phone)) {
    return res.status(400).json({ error: 'Enter a valid Kenyan phone number', errors: { phone: 'Invalid number' } });
  }
  const norm = toMpesaFormat(phone);
  const clash = await users.get({ phone: norm });
  if (clash && Number(clash.id) !== Number(user.id)) {
    return res.status(409).json({ error: 'That phone number is already registered' });
  }

  await users.update(user.id, { phone: norm });
  await notify.push(user.id, {
    title: 'Phone number updated',
    message: `Your account phone number is now ${displayKenyanPhone(norm)}.`,
    type: 'success',
  });
  await ledger.audit({ actorId: user.id, actorRole: 'user', action: 'profile.phone_changed', targetType: 'user', targetId: user.id });
  res.json({ user: publicUser(await users.byId(user.id)), message: 'Phone number updated' });
}));

// ── M-Pesa payout details (section 19) ──────────────────────
router.get('/payout', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    payout_phone: user.payout_phone ? maskPhone(user.payout_phone) : null,
    payout_phone_set: Boolean(user.payout_phone),
    verification_required: 'Account password confirmation',
  });
}));

router.post('/payout', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { phone, password } = req.body || {};

  if (!(await bcrypt.compare(String(password || ''), user.password_hash))) {
    return res.status(401).json({ error: 'Enter your account password to update payout details', errors: { password: 'Incorrect password' } });
  }
  if (!isValidKenyanPhone(phone)) {
    return res.status(400).json({ error: 'Enter a valid M-Pesa number', errors: { phone: 'Invalid number' } });
  }

  await users.update(user.id, { payout_phone: toMpesaFormat(phone) });
  await notify.push(user.id, { title: 'M-Pesa details updated', message: 'Your payout number was updated after verification.', type: 'success' });
  await ledger.audit({ actorId: user.id, actorRole: 'user', action: 'payout.updated', targetType: 'user', targetId: user.id });
  res.json({ ok: true, payout_phone: maskPhone(toMpesaFormat(phone)), message: 'M-Pesa details updated' });
}));

// ── Login sessions / logout all (section 20) ────────────────
router.get('/sessions', requireAuth, wrap(async (req, res) => {
  const rows = await sessions.all({ where: { user_id: Number(req.user.id) }, orderBy: 'created_at DESC', limit: 25 });
  res.json({
    sessions: rows.map((s) => ({
      id: s.session_id,
      current: s.session_id === req.user.sessionId,
      ip: s.ip ? `${s.ip.split('.')[0]}.•••` : null,
      device: s.user_agent ? String(s.user_agent).slice(0, 60) : 'Unknown device',
      revoked: Boolean(s.revoked),
      created_at: s.created_at,
      last_seen_at: s.last_seen_at || s.created_at,
    })),
  });
}));

router.post('/logout-all', requireAuth, wrap(async (req, res) => {
  const rows = await sessions.all({ where: { user_id: Number(req.user.id) }, limit: 200 });
  for (const s of rows) await sessions.update(s.id, { revoked: true });
  await ledger.audit({ actorId: req.user.id, actorRole: 'user', action: 'auth.logout_all', targetType: 'user', targetId: req.user.id });
  clearSessionCookies(res);
  res.json({ ok: true, message: 'Signed out of all devices' });
}));

module.exports = router;
