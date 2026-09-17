/**
 * Admin API (sections 21 – 24).
 *
 * Every number comes from the database, and no admin endpoint can invent a
 * payment outcome: deposit and withdrawal status changes only ever come from
 * the payment provider (verification call or provider callback). The only
 * exception is the sandbox simulator, which is hard-disabled in production and
 * stamps everything it touches as SANDBOX.
 */
const express = require('express');
const { Table } = require('../db');
const config = require('../config');
const { wrap, r2 } = require('../lib/helpers');
const { requireAdmin } = require('../middleware/auth');
const ledger = require('../services/ledger');
const payments = require('../services/payments');
const settings = require('../services/settings');
const notify = require('../services/notify');
const ws = require('../lib/ws');
const { shapeDeposit, shapeWithdrawal } = require('./wallet');

const router = express.Router();
router.use(requireAdmin);

const users = new Table('users');
const videos = new Table('videos');
const deposits = new Table('deposits');
const withdrawals = new Table('withdrawals');
const sessions = new Table('watch_sessions');
const referrals = new Table('referrals');
const notifications = new Table('notifications');
const auditLogs = new Table('audit_logs');

const isSandbox = () => !config.isProd && payments.describe().id === 'sandbox';

// ── Dashboard (section 21) ──────────────────────────────────
router.get('/overview', wrap(async (_req, res) => {
  const [
    registeredUsers, suspendedUsers, totalUsers,
    totalDeposits, totalWithdrawals, pendingWithdrawals, processingWithdrawals,
    completedWatches, activeVideos, ledgerRows, all, sessionsRows,
  ] = await Promise.all([
    users.count(),
    users.count({ status: 'suspended' }),
    users.count({ status: 'active' }),
    deposits.sum('amount', { status: 'successful' }),
    withdrawals.sum('amount', { status: 'completed' }),
    withdrawals.count({ status: 'pending' }),
    withdrawals.count({ status: 'processing' }),
    sessions.count({ status: 'completed' }),
    videos.count({ status: 'active' }),
    new Table('wallet_transactions').all({ orderBy: 'id DESC', limit: 5000 }),
    users.all({ orderBy: 'created_at DESC', limit: 2000 }),
    sessions.all({ where: { status: 'completed' }, orderBy: 'id DESC', limit: 2000 }),
  ]);

  // Rewards issued: completed reward entries in the ledger (source of truth).
  const rewardRows = ledgerRows.filter((r) => ['WATCH_REWARD', 'REFERRAL_REWARD'].includes(r.type) && r.status === 'COMPLETED');
  const rewardsAmount = r2(rewardRows.reduce((s, r) => s + Number(r.amount || 0), 0));
  const rewardsIssued = rewardRows.length;
  const watchSeconds = sessionsRows.reduce((s, r) => s + Number(r.watched_seconds || 0), 0);

  // Active users = accounts that were seen in the last 30 days.
  const cutoff = Date.now() - 30 * 86400000;
  const activeUsers = all.filter((u) => u.last_login && new Date(u.last_login).getTime() >= cutoff).length;

  res.json({
    currency_code: config.wallet.currency,
    cards: [
      { key: 'registered_users', label: 'Registered Users', value: registeredUsers, kind: 'count' },
      { key: 'active_users', label: 'Active Users', value: activeUsers, kind: 'count' },
      { key: 'total_deposits', label: 'Total Deposits', value: r2(totalDeposits), kind: 'money' },
      { key: 'total_withdrawals', label: 'Total Withdrawals', value: r2(totalWithdrawals), kind: 'money' },
      { key: 'pending_withdrawals', label: 'Pending Withdrawals', value: pendingWithdrawals + processingWithdrawals, kind: 'count' },
      { key: 'rewards_issued', label: 'Rewards Issued', value: r2(rewardsAmount), kind: 'money' },
    ],
    extra: {
      suspended_users: suspendedUsers,
      total_users: totalUsers,
      completed_watches: completedWatches,
      active_videos: activeVideos,
      watch_reward_entries: rewardsIssued,
      verified_watch_seconds: watchSeconds,
    },
    payment_provider: payments.describe(),
  });
}));

// ── Users ───────────────────────────────────────────────────
router.get('/users', wrap(async (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  const rows = await users.all({ orderBy: 'created_at DESC', limit: 500 });
  const filtered = q
    ? rows.filter((u) => (u.fullname || '').toLowerCase().includes(q)
      || (u.email || '').toLowerCase().includes(q)
      || String(u.phone || '').includes(q)
      || (u.username || '').toLowerCase().includes(q))
    : rows;

  res.json({
    users: filtered.slice(0, 200).map((u) => ({
      id: u.id,
      fullname: u.fullname,
      username: u.username,
      email: u.email,
      phone: u.phone,
      balance: r2(u.balance),
      pending_balance: r2(u.pending_balance),
      total_earned: r2(u.total_earned),
      total_deposited: r2(u.total_deposited),
      total_withdrawn: r2(u.total_withdrawn),
      watched_count: Number(u.watched_count || 0),
      status: u.status,
      role: u.role,
      referral_code: u.referral_code,
      created_at: u.created_at,
      last_login: u.last_login,
    })),
  });
}));

router.get('/users/:id', wrap(async (req, res) => {
  const u = await users.byId(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const totals = await ledger.totals(u.id);
  res.json({
    user: { ...u, password_hash: undefined },
    ledger_totals: totals,
    reconciliation: await ledger.reconcile(u.id),
  });
}));

router.post('/users/:id/suspend', wrap(async (req, res) => {
  const u = await users.byId(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.role === 'admin') return res.status(400).json({ error: 'Admins cannot be suspended from here' });
  const status = u.status === 'suspended' ? 'active' : 'suspended';
  await users.update(u.id, { status });
  await notify.push(u.id, {
    title: status === 'suspended' ? 'Account suspended' : 'Account reinstated',
    message: status === 'suspended'
      ? 'Your account was suspended pending a policy review. Please contact support.'
      : 'Your account is active again.',
    type: status === 'suspended' ? 'danger' : 'success',
  });
  await ledger.audit({ actorId: req.user.id, actorRole: 'admin', action: `user.${status}`, targetType: 'user', targetId: u.id });
  res.json({ ok: true, status });
}));

// ── Video management (section 22) ───────────────────────────
router.get('/videos', wrap(async (_req, res) => {
  const rows = await videos.all({ orderBy: 'created_at DESC', limit: 300 });
  res.json({
    videos: rows.map((v) => ({
      id: v.id,
      title: v.title,
      description: v.description,
      video_url: v.video_url,
      duration_seconds: Number(v.duration_seconds),
      reward: r2(v.reward),
      currency_code: v.currency_code,
      daily_limit: Number(v.daily_limit),
      status: v.status,
      created_at: v.created_at,
    })),
  });
}));

function validateVideo(body) {
  const errors = {};
  const title = String(body.title || '').trim();
  const videoUrl = String(body.video_url || '').trim();
  const duration = Number(body.duration_seconds);
  const reward = r2(body.reward);
  const dailyLimit = Number(body.daily_limit ?? 1);

  if (title.length < 3) errors.title = 'Title is required';
  if (!/^https?:\/\//i.test(videoUrl)) errors.video_url = 'A http(s) video URL is required';
  if (!Number.isFinite(duration) || duration < 5) errors.duration_seconds = 'Duration must be at least 5 seconds';
  if (!(reward > 0)) errors.reward = 'Reward must be greater than zero';
  if (!Number.isFinite(dailyLimit) || dailyLimit < 1) errors.daily_limit = 'Daily limit must be at least 1';

  return {
    errors,
    values: {
      title: title.slice(0, 160),
      description: String(body.description || '').slice(0, 4000),
      video_url: videoUrl,
      duration_seconds: Math.round(duration),
      reward,
      currency_code: config.wallet.currency,
      daily_limit: Math.round(dailyLimit),
      status: body.status === 'inactive' ? 'inactive' : 'active',
    },
  };
}

router.post('/videos', wrap(async (req, res) => {
  const { errors, values } = validateVideo(req.body || {});
  if (Object.keys(errors).length) return res.status(400).json({ error: Object.values(errors)[0], errors });

  const video = await videos.create({ ...values, created_by: Number(req.user.id) });
  await ledger.audit({ actorId: req.user.id, actorRole: 'admin', action: 'video.created', targetType: 'video', targetId: video.id, detail: values.title });
  res.status(201).json({ video });
}));

router.put('/videos/:id', wrap(async (req, res) => {
  const video = await videos.byId(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  const { errors, values } = validateVideo({ ...video, ...req.body });
  if (Object.keys(errors).length) return res.status(400).json({ error: Object.values(errors)[0], errors });

  const updated = await videos.update(video.id, { ...values, updated_at: new Date().toISOString() });
  await ledger.audit({ actorId: req.user.id, actorRole: 'admin', action: 'video.updated', targetType: 'video', targetId: video.id, detail: values.title });
  res.json({ video: updated });
}));

router.post('/videos/:id/status', wrap(async (req, res) => {
  const video = await videos.byId(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  const status = req.body.status === 'inactive' ? 'inactive' : 'active';
  const updated = await videos.update(video.id, { status, updated_at: new Date().toISOString() });
  await ledger.audit({ actorId: req.user.id, actorRole: 'admin', action: `video.${status}`, targetType: 'video', targetId: video.id });
  res.json({ video: updated });
}));

router.delete('/videos/:id', wrap(async (req, res) => {
  const video = await videos.byId(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  // Soft delete: completed sessions keep pointing at a real record.
  await videos.update(video.id, { status: 'inactive', updated_at: new Date().toISOString() });
  await ledger.audit({ actorId: req.user.id, actorRole: 'admin', action: 'video.deleted', targetType: 'video', targetId: video.id, detail: video.title });
  res.json({ ok: true, deleted: video.id, note: 'Video disabled and hidden from the task list' });
}));

// ── Deposits (section 24) ───────────────────────────────────
router.get('/deposits', wrap(async (req, res) => {
  const status = req.query.status ? { status: String(req.query.status) } : {};
  const rows = await deposits.all({ where: status, orderBy: 'created_at DESC', limit: 200 });
  const out = [];
  for (const d of rows) {
    const u = await users.byId(d.user_id);
    out.push({ ...shapeDeposit(d), username: u ? u.username : '?', user_id: d.user_id, provider: d.provider || null });
  }
  res.json({ deposits: out, payment_provider: payments.describe() });
}));

/**
 * Verification asks the provider for the authoritative result. An admin cannot
 * mark a deposit paid by hand — in live mode the only way to Successful is a
 * confirmed M-Pesa result.
 */
router.post('/deposits/:id/verify', wrap(async (req, res) => {
  const deposit = await deposits.byId(req.params.id);
  if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
  if (['successful', 'failed'].includes(deposit.status)) {
    return res.json({ ok: true, deposit: shapeDeposit(deposit), idempotent: true });
  }

  let out;
  try {
    out = await payments.refreshDeposit(deposit);
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message });
  }
  await ledger.audit({
    actorId: req.user.id, actorRole: 'admin', action: 'deposit.verify',
    targetType: 'deposit', targetId: deposit.txn_id,
    detail: `result=${out.status || 'pending'} provider=${payments.providerName()}`,
  });
  const fresh = await deposits.byId(deposit.id);
  res.json({
    ok: true,
    deposit: shapeDeposit(fresh || deposit),
    provider_result: out.status || 'pending',
    detail: out.detail || null,
    note: out.pending ? 'The provider has not confirmed this payment yet.' : undefined,
  });
}));

/** Development-only simulator (never available in production). */
router.post('/deposits/:id/simulate', wrap(async (req, res) => {
  if (!isSandbox()) return res.status(403).json({ error: 'Sandbox simulation is disabled' });
  const deposit = await deposits.byId(req.params.id);
  if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
  const provider = payments.getProvider();
  const parsed = provider.simulate({
    kind: 'deposit',
    providerRef: deposit.provider_ref,
    result: req.body.result === 'FAILED' ? 'FAILED' : 'SUCCESS',
  });
  const out = await payments.applyDepositResult(deposit, {
    result: parsed.result, reference: parsed.reference, detail: parsed.detail, sandbox: true,
  });
  await ledger.audit({ actorId: req.user.id, actorRole: 'admin', action: 'deposit.simulated', targetType: 'deposit', targetId: deposit.txn_id, detail: parsed.reference });
  res.json({ ok: true, sandbox: true, status: out.status || deposit.status, reference: parsed.reference });
}));

// ── Withdrawals (section 23) ────────────────────────────────
router.get('/withdrawals', wrap(async (req, res) => {
  const status = req.query.status ? { status: String(req.query.status) } : {};
  const rows = await withdrawals.all({ where: status, orderBy: 'created_at DESC', limit: 200 });
  const out = [];
  for (const w of rows) {
    const u = await users.byId(w.user_id);
    out.push({ ...shapeWithdrawal(w), username: u ? u.username : '?', user_id: w.user_id, provider: w.provider || null });
  }
  res.json({ withdrawals: out, payment_provider: payments.describe() });
}));

/**
 * Process a payout: asks the provider to send the money and records whatever
 * the provider answered. Status only becomes Completed from a provider result.
 */
router.post('/withdrawals/:id/process', wrap(async (req, res) => {
  const withdrawal = await withdrawals.byId(req.params.id);
  if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
  if (['completed', 'failed'].includes(withdrawal.status)) {
    return res.json({ ok: true, withdrawal: shapeWithdrawal(withdrawal), idempotent: true });
  }

  const user = await users.byId(withdrawal.user_id);
  try {
    if (!withdrawal.provider_ref) {
      const started = await payments.startWithdrawal({
        user, withdrawal, phone: withdrawal.destination, amount: withdrawal.net_amount,
      });
      await ledger.audit({ actorId: req.user.id, actorRole: 'admin', action: 'withdrawal.submitted', targetType: 'withdrawal', targetId: withdrawal.request_id, detail: started.provider });
      const fresh = await withdrawals.byId(withdrawal.id);
      return res.json({
        ok: true,
        withdrawal: shapeWithdrawal(fresh || withdrawal),
        message: started.message || 'Payout submitted to the provider — status stays Pending until it is confirmed.',
      });
    }
    const out = await payments.refreshWithdrawal(withdrawal);
    await ledger.audit({ actorId: req.user.id, actorRole: 'admin', action: 'withdrawal.verify', targetType: 'withdrawal', targetId: withdrawal.request_id, detail: `result=${out.status}` });
    const fresh = await withdrawals.byId(withdrawal.id);
    res.json({ ok: true, withdrawal: shapeWithdrawal(fresh || withdrawal), provider_result: out.status });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
}));

/** Development-only simulator for payouts. */
router.post('/withdrawals/:id/simulate', wrap(async (req, res) => {
  if (!isSandbox()) return res.status(403).json({ error: 'Sandbox simulation is disabled' });
  const withdrawal = await withdrawals.byId(req.params.id);
  if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
  const provider = payments.getProvider();
  const parsed = provider.simulate({
    kind: 'withdrawal',
    providerRef: withdrawal.provider_ref,
    result: req.body.result === 'FAILED' ? 'FAILED' : 'SUCCESS',
  });
  const out = await payments.applyWithdrawalResult(withdrawal, {
    result: parsed.result === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
    reference: parsed.reference,
    detail: parsed.detail,
  });
  await ledger.audit({ actorId: req.user.id, actorRole: 'admin', action: 'withdrawal.simulated', targetType: 'withdrawal', targetId: withdrawal.request_id, detail: parsed.reference });
  res.json({ ok: true, sandbox: true, status: out.status });
}));

// ── Rewards / ledger ────────────────────────────────────────
router.get('/rewards', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const rows = await new Table('wallet_transactions').all({ orderBy: 'created_at DESC', limit: 500 });
  const rewards = rows.filter((r) => ['WATCH_REWARD', 'REFERRAL_REWARD'].includes(r.type)).slice(0, limit);
  const out = [];
  for (const r of rewards) {
    const u = await users.byId(r.user_id);
    out.push({
      txn_id: r.txn_id,
      type: r.type,
      status: r.status,
      amount: r2(r.amount),
      currency_code: r.currency_code,
      description: r.description,
      username: u ? u.username : '?',
      created_at: r.created_at,
    });
  }
  res.json({
    rewards: out,
    totals: {
      watch_rewards: r2(rows.filter((r) => r.type === 'WATCH_REWARD' && r.status === 'COMPLETED').reduce((s, r) => s + Number(r.amount), 0)),
      referral_rewards: r2(rows.filter((r) => r.type === 'REFERRAL_REWARD' && r.status === 'COMPLETED').reduce((s, r) => s + Number(r.amount), 0)),
    },
  });
}));

router.get('/ledger', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const rows = await new Table('wallet_transactions').all({ orderBy: 'created_at DESC', limit });
  res.json({
    transactions: rows.map((r) => ({
      txn_id: r.txn_id,
      user_id: r.user_id,
      type: r.type,
      status: r.status,
      amount: r2(r.amount),
      currency_code: r.currency_code,
      description: r.description,
      reference: r.reference,
      idempotency_key: r.idempotency_key,
      balance_after: r.balance_after != null ? r2(r.balance_after) : null,
      created_at: r.created_at,
    })),
  });
}));

// ── Referrals ───────────────────────────────────────────────
router.get('/referrals', wrap(async (_req, res) => {
  const rows = await referrals.all({ orderBy: 'created_at DESC', limit: 300 });
  const out = [];
  for (const rel of rows) {
    const referrer = await users.byId(rel.referrer_id);
    const referred = await users.byId(rel.referred_user_id);
    out.push({
      id: rel.id,
      referrer: referrer ? referrer.username : '?',
      referred: referred ? referred.username : '?',
      level: rel.level,
      commission: r2(rel.commission),
      qualified: Boolean(rel.qualified_at),
      created_at: rel.created_at,
    });
  }
  res.json({ referrals: out });
}));

// ── Notifications broadcast ─────────────────────────────────
router.get('/notifications', wrap(async (_req, res) => {
  const rows = await notifications.all({ orderBy: 'created_at DESC', limit: 100 });
  res.json({ notifications: rows });
}));

router.post('/notifications/broadcast', wrap(async (req, res) => {
  const title = String(req.body.title || '').trim();
  const message = String(req.body.message || '').trim();
  if (!title || !message) return res.status(400).json({ error: 'Title and message are required' });

  const row = await notifications.create({
    user_id: null,
    title: title.slice(0, 160),
    message: message.slice(0, 2000),
    type: ['info', 'success', 'warning', 'danger'].includes(req.body.type) ? req.body.type : 'info',
  });
  ws.broadcastAll({ type: 'announcement', payload: row });
  await ledger.audit({ actorId: req.user.id, actorRole: 'admin', action: 'notification.broadcast', targetType: 'notification', targetId: row.id, detail: title });
  res.status(201).json({ ok: true, notification: row });
}));

// ── Settings ────────────────────────────────────────────────
router.get('/settings', wrap(async (_req, res) => {
  res.json({ settings: await settings.getAll(), public: await settings.publicConfig() });
}));

router.put('/settings', wrap(async (req, res) => {
  const { applied, settings: all } = await settings.update(req.body || {}, req.user.id);
  res.json({ ok: true, applied, settings: all });
}));

// ── Audit logs ──────────────────────────────────────────────
router.get('/audit-logs', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 300);
  const rows = await auditLogs.all({ orderBy: 'created_at DESC', limit });
  res.json({
    logs: rows.map((l) => ({
      id: l.id,
      actor_id: l.actor_id,
      actor_role: l.actor_role,
      action: l.action,
      target_type: l.target_type,
      target_id: l.target_id,
      detail: l.detail,
      created_at: l.created_at,
    })),
  });
}));

// ── Watch sessions (support view) ───────────────────────────
router.get('/watch-sessions', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const rows = await sessions.all({ orderBy: 'created_at DESC', limit });
  const out = [];
  for (const s of rows) {
    const u = await users.byId(s.user_id);
    const v = await videos.byId(s.video_id);
    out.push({
      id: s.id,
      username: u ? u.username : '?',
      video: v ? v.title : `#${s.video_id}`,
      status: s.status,
      watched_seconds: Number(s.watched_seconds),
      required_seconds: Number(s.required_seconds),
      reward: r2(s.reward_amount),
      reward_txn_id: s.reward_txn_id || null,
      created_at: s.created_at,
      completed_at: s.completed_at || null,
    });
  }
  res.json({ sessions: out });
}));

module.exports = router;
