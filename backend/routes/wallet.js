const express = require('express');
const { Table } = require('../db');
const config = require('../config');
const { wrap, r2, toMpesaFormat, isValidKenyanPhone } = require('../lib/helpers');
const { formatMoney } = require('../lib/money');
const { depositMethods, withdrawalMethods, isMpesaCountry } = require('../lib/countries');
const { requireAuth } = require('../middleware/auth');
const { stkPush, demoCallbackBody } = require('../services/mpesa');
const { notify } = require('../services/earnings');
const ws = require('../lib/ws');

const router = express.Router();
const users = new Table('users');
const deposits = new Table('deposits');
const withdrawals = new Table('withdrawals');
const packages = new Table('packages');
const promos = new Table('promo_codes');
const promoRedemptions = new Table('promo_redemptions');
const notifications = new Table('notifications');

// ── Deposit methods available to the current user ────────
router.get('/deposit-methods', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    country_code: user.country_code || null,
    currency_code: user.currency_code || null,
    methods: depositMethods(user.country_code),
  });
}));

// ── Withdrawal methods available to the current user ─────
router.get('/withdraw-methods', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    country_code: user.country_code || null,
    currency_code: user.currency_code || null,
    methods: withdrawalMethods(user.country_code),
  });
}));

// ── Deposits ──────────────────────────────────────────────
router.post('/deposit', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // M-Pesa (Daraja) is implemented for Kenyan accounts only.
  if (!isMpesaCountry(user.country_code)) {
    return res.status(403).json({ error: 'M-Pesa deposits are currently available in Kenya only' });
  }

  const { amount, phone } = req.body || {};
  const amt = r2(Number(amount));
  if (!amt || amt < config.wallet.minDeposit) return res.status(400).json({ error: `Minimum deposit is ${formatMoney(config.wallet.minDeposit, user.currency_code, 0)}` });
  if (amt > 150000) return res.status(400).json({ error: `Maximum deposit is ${formatMoney(150000, user.currency_code, 0)}` });
  if (!isValidKenyanPhone(phone)) return res.status(400).json({ error: 'Enter a valid M-Pesa number (07XX… or 2547XX…)' });

  const mpesaPhone = toMpesaFormat(phone);
  const deposit = await deposits.create({
    user_id: req.user.id,
    amount: amt,
    currency_code: user.currency_code || 'KES',
    payment_method: 'mpesa',
    phone: mpesaPhone,
    status: 'pending',
  });

  try {
    const { providerRef, demo } = await stkPush({ phone: mpesaPhone, amount: amt, accountRef: 'TaskCash' });
    await deposits.update(deposit.id, { provider_ref: providerRef });

    if (demo) {
      // Demo mode: simulate Daraja callback shortly after
      setTimeout(async () => {
        try {
          await require('../services/mpesa-webhook').processCallback(demoCallbackBody(deposit));
          console.log(`[mpesa:demo] deposit #${deposit.id} auto-approved`);
        } catch (e) { console.warn('[mpesa:demo] failed:', e.message); }
      }, 8000).unref?.();
    }

    res.json({
      ok: true,
      deposit_id: deposit.id,
      status: demo ? 'processing-demo' : 'processing',
      demo,
      message: demo
        ? 'Demo mode: no M-Pesa keys configured — the deposit auto-confirms in ~8s.'
        : 'Check your phone and enter your M-Pesa PIN to complete the payment.',
    });
  } catch (e) {
    await deposits.update(deposit.id, { status: 'rejected', failure_reason: String(e.message).slice(0, 300) });
    res.status(502).json({ error: `M-Pesa request failed: ${e.message}` });
  }
}));

// Deposit status polling
router.get('/deposit/:id', requireAuth, wrap(async (req, res) => {
  const d = await deposits.byId(req.params.id);
  if (!d || d.user_id !== req.user.id) return res.status(404).json({ error: 'Deposit not found' });
  res.json({ deposit: { id: d.id, amount: r2(d.amount), status: d.status, reference: d.provider_ref, created_at: d.created_at } });
}));

router.get('/deposits', requireAuth, wrap(async (req, res) => {
  const rows = await deposits.all({ where: { user_id: req.user.id }, orderBy: 'created_at DESC', limit: 50 });
  res.json({ deposits: rows.map((d) => ({ ...d, amount: r2(d.amount) })) });
}));

// ── Withdrawals ───────────────────────────────────────────
router.post('/withdraw', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });
  if (user.kyc_status !== 'verified') {
    return res.status(403).json({ error: 'Account verification (KYC) required before withdrawals. Visit Settings → Verify account.' });
  }

  const { amount, method, destination } = req.body || {};
  const amt = r2(Number(amount));
  const cur = user.currency_code || 'KES';
  // Only payout methods actually implemented for this user's country.
  const available = withdrawalMethods(user.country_code).filter((m) => m.implemented).map((m) => m.id);
  if (!available.includes(String(method || ''))) {
    return res.status(400).json({ error: 'That payout method is not available in your country yet' });
  }
  if (!amt || amt < config.wallet.minWithdrawal) {
    return res.status(400).json({ error: `Minimum withdrawal is ${formatMoney(config.wallet.minWithdrawal, cur, 0)}` });
  }
  if (amt > Number(user.balance)) return res.status(400).json({ error: 'Amount exceeds available balance' });

  const fee = r2(amt * config.wallet.withdrawalFeePct / 100);
  const net = r2(amt - fee);

  // Daily limit check
  const db = require('../db').getDb();
  const todayRows = await withdrawals.all({ where: { user_id: user.id }, limit: 200 });
  const today = new Date().toISOString().slice(0, 10);
  const todaySum = todayRows
    .filter((w) => String(w.created_at).slice(0, 10) === today && w.status !== 'rejected')
    .reduce((s, w) => s + Number(w.amount), 0);
  if (todaySum + amt > config.wallet.withdrawalDailyLimit) {
    return res.status(429).json({ error: `Daily withdrawal limit is ${formatMoney(config.wallet.withdrawalDailyLimit, cur, 0)}` });
  }

  let dest = String(destination || '').trim();
  if (method === 'mpesa') {
    if (!isValidKenyanPhone(dest)) return res.status(400).json({ error: 'Enter a valid M-Pesa number' });
    dest = toMpesaFormat(dest);
  } else if (method === 'bank') {
    if (!/^[A-Za-z0-9 /-]{6,40}$/.test(dest)) return res.status(400).json({ error: 'Enter a valid bank account number' });
  } else {
    return res.status(400).json({ error: 'Unsupported method' });
  }

  // Hold funds + create pending withdrawal
  await users.adjust(user.id, 'balance', -amt);
  await users.adjust(user.id, 'pending_balance', amt);
  const wd = await withdrawals.create({
    user_id: user.id, amount: amt, fee, net_amount: net,
    currency_code: cur,
    method, destination: dest, status: 'pending',
  });

  await notify(user.id, 'Withdrawal requested', `${formatMoney(amt, cur)} (net ${formatMoney(net, cur)} after fee) is pending admin approval.`, 'info');
  ws.broadcastAdmins({ type: 'admin_alert', payload: { kind: 'withdrawal', id: wd.id } });

  res.json({
    ok: true, withdrawal: wd,
    message: 'Withdrawal requested. Funds on hold until approval (usually within 24h).',
  });
}));

router.get('/withdrawals', requireAuth, wrap(async (req, res) => {
  const rows = await withdrawals.all({ where: { user_id: req.user.id }, orderBy: 'created_at DESC', limit: 50 });
  res.json({ withdrawals: rows.map((w) => ({ ...w, amount: r2(w.amount), fee: r2(w.fee), net_amount: r2(w.net_amount) })) });
}));

router.get('/deposits', requireAuth, wrap(async (req, res) => {
  const rows = await deposits.all({ where: { user_id: req.user.id }, orderBy: 'created_at DESC', limit: 50 });
  res.json({ deposits: rows.map((d) => ({ ...d, amount: r2(d.amount) })) });
}));

// ── Packages ──────────────────────────────────────────────
router.get('/packages', wrap(async (_req, res) => {
  const rows = await packages.all({ where: { is_active: true }, orderBy: 'price ASC' });
  res.json({ packages: rows.map((p) => ({ ...p, price: r2(p.price), benefits: p.benefits })) });
}));

router.post('/packages/:id/purchase', requireAuth, wrap(async (req, res) => {
  const pkg = await packages.byId(req.params.id);
  if (!pkg || !pkg.is_active) return res.status(404).json({ error: 'Package not available' });

  const user = await users.byId(req.user.id);
  if (Number(user.balance) < Number(pkg.price)) {
    return res.status(400).json({ error: `Insufficient balance. This package costs ${formatMoney(r2(pkg.price), user.currency_code)}.` });
  }

  const expires = new Date(Date.now() + pkg.duration_days * 86400000).toISOString();
  await users.adjust(user.id, 'balance', -Number(pkg.price));
  await users.update(user.id, { package_id: pkg.id, package_expires: expires });
  await notify(user.id, `${pkg.name} package active 🚀`, `Daily task cap is now ${pkg.daily_tasks}. Expires ${expires.slice(0, 10)}.`, 'success');

  res.json({ ok: true, package: pkg, expires, message: `${pkg.name} package activated!` });
}));

// ── Promo codes ───────────────────────────────────────────
router.post('/promo/redeem', requireAuth, wrap(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Enter a promo code' });

  const promo = await promos.get({ code, is_active: true });
  if (!promo) return res.status(404).json({ error: 'Invalid or expired promo code' });
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) return res.status(400).json({ error: 'This promo code has expired' });
  if (promo.used_count >= promo.max_uses) return res.status(400).json({ error: 'This promo code has reached its limit' });
  if (await promoRedemptions.get({ code_id: promo.id, user_id: req.user.id })) {
    return res.status(409).json({ error: 'You already redeemed this code' });
  }

  const me = await users.byId(req.user.id);
  const cur = me ? me.currency_code : 'KES';
  await promoRedemptions.create({ code_id: promo.id, user_id: req.user.id });
  await promos.adjust(promo.id, 'used_count', 1);
  await users.adjust(req.user.id, 'balance', promo.amount);
  await users.adjust(req.user.id, 'total_earned', promo.amount);
  await notify(req.user.id, 'Promo code redeemed 🎁', `${code}: ${formatMoney(r2(promo.amount), cur)} credited to your balance.`, 'success');

  res.json({ ok: true, amount: r2(promo.amount), currency_code: cur, message: `${formatMoney(r2(promo.amount), cur)} added via ${code}!` });
}));

module.exports = router;
