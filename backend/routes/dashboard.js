const express = require('express');
const { Table } = require('../db');
const config = require('../config');
const { wrap, r2 } = require('../lib/helpers');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { notify } = require('../services/earnings');
const ws = require('../lib/ws');

const router = express.Router();
const users = new Table('users');
const tasks = new Table('tasks');
const completions = new Table('task_completions');
const deposits = new Table('deposits');
const withdrawals = new Table('withdrawals');
const referrals = new Table('referrals');
const feed = new Table('earnings_feed');
const achievements = new Table('achievements');
const packages = new Table('packages');

router.get('/stats', requireAuth, wrap(async (req, res) => {
  const u = await users.byId(req.user.id);
  if (!u) return res.status(404).json({ error: 'User not found' });

  const [earnTotal, refCount, pendCount, pendEarn, badges] = await Promise.all([
    completions.sum('reward_paid', { user_id: u.id }),
    referrals.count({ referrer_id: u.id }),
    completions.count({ user_id: u.id, status: 'pending' }),
    completions.sum('reward_paid', { user_id: u.id, status: 'pending' }),
    achievements.all().then((rows) => rows.filter((a) => a.user_id === u.id)),
  ]);

  const pkg = u.package_id ? await packages.byId(u.package_id) : null;
  const pkgActive = pkg && new Date(u.package_expires) > new Date();

  res.json({
    stats: {
      available: r2(u.balance),
      pending: r2(u.pending_balance),
      total_earned: r2(u.total_earned),
      referral_earnings: r2(u.referral_earnings),
      tasks_completed: u.tasks_completed || 0,
      tasks_pending: pendCount,
      pending_earnings: r2(pendEarn),
      task_rewards_sum: r2(earnTotal),
      referrals: refCount,
      checkin_streak: u.checkin_streak || 0,
      badges: badges.map((b) => b.badge),
      package: pkgActive ? { id: pkg.id, name: pkg.name, expires: u.package_expires, daily_tasks: pkg.daily_tasks } : null,
    },
  });
}));

// Admin analytics
router.get('/admin/analytics', requireAdmin, wrap(async (_req, res) => {
  const db = require('../db').getDb();
  const [userGrowth, depositSeries, withdrawalSeries, tasksSeries] = await Promise.all([
    db.timeSeries('users', 'created_at', 14),
    db.timeSeries('deposits', 'created_at', 14, { field: 'amount', where: { status: 'approved' } }),
    db.timeSeries('withdrawals', 'created_at', 14, { field: 'amount', where: { status: 'approved' } }),
    db.timeSeries('task_completions', 'created_at', 14, { where: { status: 'approved' } }),
  ]);
  const [usersN, depositsSum, withdrawalsSum, tasksApproved, tasksPending, usersSuspended] = await Promise.all([
    users.count(), deposits.sum('amount', { status: 'approved' }),
    withdrawals.sum('amount', { status: 'approved' }),
    completions.count({ status: 'approved' }), completions.count({ status: 'pending' }),
    users.count({ status: 'suspended' }),
  ]);
  res.json({
    totals: {
      users: usersN, suspended: usersSuspended,
      deposits: r2(depositsSum), withdrawals: r2(withdrawalsSum),
      tasks_approved: tasksApproved, tasks_pending: tasksPending,
    },
    series: { users: userGrowth, deposits: depositSeries, withdrawals: withdrawalSeries, tasks: tasksSeries },
  });
}));

// Activity history: deposits, withdrawals, completions in one timeline
router.get('/history', requireAuth, wrap(async (req, res) => {
  const type = String(req.query.type || 'all');
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const out = [];

  const addRows = (rows, kind) => rows.forEach((r) => out.push({
    id: `${kind}-${r.id}`, kind,
    title: kind === 'deposit' ? 'M-Pesa deposit'
      : kind === 'withdrawal' ? `Withdrawal (${r.method})`
      : kind === 'task' ? (r.task_title || 'Task reward')
      : 'Referral commission',
    amount: r2(kind === 'withdrawal' ? -Number(r.amount) : kind === 'task' ? Number(r.reward_paid || 0) : Number(r.amount || 0)),
    status: r.status, date: r.created_at,
    ref: r.reference || r.provider_ref || null,
  }));

  if (type === 'all' || type === 'deposits') {
    addRows(await deposits.all({ where: { user_id: req.user.id }, orderBy: 'created_at DESC', limit }), 'deposit');
  }
  if (type === 'all' || type === 'withdrawals') {
    addRows(await withdrawals.all({ where: { user_id: req.user.id }, orderBy: 'created_at DESC', limit }), 'withdrawal');
  }
  if (type === 'all' || type === 'tasks') {
    const rows = await completions.all({ where: { user_id: req.user.id }, orderBy: 'created_at DESC', limit });
    for (const c of rows) {
      const t = await tasks.byId(c.task_id);
      addRows([{ ...c, task_title: t ? t.title : 'Task' }], 'task');
    }
  }
  if (type === 'all' || type === 'referrals') {
    const rels = await referrals.all({ where: { referrer_id: req.user.id }, orderBy: 'created_at DESC', limit });
    for (const rel of rels) {
      if (Number(rel.commission) > 0) {
        const ru = await users.byId(rel.referred_user_id);
        addRows([{ ...rel, amount: rel.commission }], 'referral');
      }
    }
  }
  out.sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json({ history: out.slice(0, limit) });
}));

// Live public earnings feed (for homepage + dashboard)
router.get('/feed', wrap(async (_req, res) => {
  const rows = await feed.all({ orderBy: 'created_at DESC', limit: 12 });
  res.json({ feed: rows });
}));

// Daily check-in with streak bonus
router.post('/checkin', requireAuth, wrap(async (req, res) => {
  const u = await users.byId(req.user.id);
  if (!u) return res.status(404).json({ error: 'User not found' });

  const today = new Date().toISOString().slice(0, 10);
  const last = u.last_checkin ? String(u.last_checkin).slice(0, 10) : null;
  if (last === today) return res.status(400).json({ error: 'Already checked in today — come back tomorrow!' });

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const streak = last === yesterday ? (u.checkin_streak || 0) + 1 : 1;
  const reward = r2(Math.min(config.wallet.checkInBase + (streak - 1), config.wallet.checkInCap));

  await users.update(u.id, { checkin_streak: streak, last_checkin: today });
  await users.adjust(u.id, 'balance', reward);
  await users.adjust(u.id, 'total_earned', reward);
  await completions.create({
    user_id: u.id, task_id: null, proof: null, status: 'approved',
    reward_paid: reward,
  });
  await notify(u.id, 'Daily check-in ✅', `Day ${streak} streak! KES ${reward.toFixed(2)} bonus credited.`, 'success');

  res.json({ ok: true, reward, streak, message: `KES ${reward.toFixed(2)} added! Streak: ${streak} day(s)` });
}));

// Leaderboard (opt-in via share stats)
router.get('/leaderboard', wrap(async (_req, res) => {
  const rows = await users.all({ where: { status: 'active' }, orderBy: 'total_earned DESC', limit: 10 });
  res.json({
    leaderboard: rows.map((u, i) => ({
      rank: i + 1, username: u.username ? `${u.username.slice(0, 3)}***` : 'user***',
      total_earned: r2(u.total_earned), tasks: u.tasks_completed || 0,
    })),
  });
}));

module.exports = router;
