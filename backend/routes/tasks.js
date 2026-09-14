const express = require('express');
const { Table } = require('../db');
const config = require('../config');
const crypto = require('crypto');
const { wrap, r2 } = require('../lib/helpers');
const { formatMoney } = require('../lib/money');
const { requireAuth } = require('../middleware/auth');
const { notify } = require('../services/earnings');
const { resolveReward, isTaskAvailable } = require('../services/rewards');

const router = express.Router();
const tasks = new Table('tasks');
const completions = new Table('task_completions');
const users = new Table('users');
const packages = new Table('packages');

function packageRank(name) {
  const order = ['starter', 'silver', 'gold', 'platinum'];
  const i = order.indexOf(String(name || '').toLowerCase());
  return i === -1 ? -1 : i;
}

async function userActivePackage(user) {
  if (!user.package_id) return null;
  const pkg = await packages.byId(user.package_id);
  if (!pkg) return null;
  if (user.package_expires && new Date(user.package_expires) < new Date()) return null;
  return pkg;
}

async function todaysCount(userId, taskId) {
  const rows = await completions.all({ where: { user_id: userId, task_id: taskId }, limit: 500 });
  const today = new Date().toISOString().slice(0, 10);
  return rows.filter((c) => String(c.created_at).slice(0, 10) === today).length;
}

// ── Marketplace ───────────────────────────────────────────
router.get('/', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const pkg = await userActivePackage(user);
  const rank = pkg ? packageRank(pkg.name) : -1;

  const active = await tasks.all({ where: { status: 'active' }, orderBy: 'created_at DESC', limit: 200 });
  const dailyCap = pkg ? pkg.daily_tasks : 3; // free tier: 3 task submissions/day

  const enriched = [];
  for (const t of active) {
    // Availability: global tasks everywhere; country tasks only in listed countries.
    if (!isTaskAvailable(t, user)) continue;

    // Reward: resolved server-side from the user's country configuration.
    const reward = await resolveReward(t, user);
    const minRank = packageRank(t.min_package);
    const locked = minRank > rank;
    const doneToday = await todaysCount(user.id, t.id);
    enriched.push({
      id: t.id, title: t.title, description: t.description, category: t.category,
      reward: reward.amount,
      currency_code: reward.currency_code,
      reward_display: formatMoney(reward.amount, reward.currency_code, 0),
      time_required: t.time_required,
      verification_type: t.verification_type, url: t.url,
      instructions: t.instructions, min_package: t.min_package,
      availability_type: t.availability_type || 'global',
      locked, done_today: doneToday, daily_limit: t.daily_limit || 1,
      completed: doneToday >= (t.daily_limit || 1),
    });
  }

  res.json({
    tasks: enriched,
    daily_cap: dailyCap,
    currency_code: user.currency_code,
    package: pkg ? { id: pkg.id, name: pkg.name, daily_tasks: pkg.daily_tasks } : null,
  });
}));

// ── My submissions ────────────────────────────────────────
router.get('/mine', requireAuth, wrap(async (req, res) => {
  const rows = await completions.all({ where: { user_id: req.user.id }, orderBy: 'created_at DESC', limit: 50 });
  const out = [];
  for (const c of rows) {
    const t = c.task_id ? await tasks.byId(c.task_id) : null;
    out.push({
      id: c.id, task_id: c.task_id, task_title: t ? t.title : 'Daily check-in bonus',
      status: c.status, proof: c.proof, reward_paid: r2(c.reward_paid),
      currency_code: c.currency_code || null,
      admin_note: c.admin_note || null, created_at: c.created_at,
    });
  }
  res.json({ completions: out });
}));

// ── Submit a task ─────────────────────────────────────────
router.post('/:id/submit', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

  const task = await tasks.byId(req.params.id);
  if (!task || task.status !== 'active') return res.status(404).json({ error: 'Task not available' });

  // Server-side availability check — country-restricted tasks enforced here.
  if (!isTaskAvailable(task, user)) return res.status(403).json({ error: 'This task is not available in your country' });

  const pkg = await userActivePackage(user);
  const rank = pkg ? packageRank(pkg.name) : -1;
  if (packageRank(task.min_package) > rank) {
    return res.status(403).json({ error: `This task requires the ${task.min_package} package or higher` });
  }

  // Reward resolved server-side — never trusted from the browser.
  const reward = await resolveReward(task, user);

  // Daily caps
  const dailyCap = pkg ? pkg.daily_tasks : 3;
  const today = new Date().toISOString().slice(0, 10);
  const mineToday = (await completions.all({ where: { user_id: user.id }, limit: 1000 }))
    .filter((c) => String(c.created_at).slice(0, 10) === today);
  if (mineToday.length >= dailyCap) {
    return res.status(429).json({ error: `Daily limit reached (${dailyCap} submissions). Upgrade your package for more.` });
  }
  if (await todaysCount(user.id, task.id) >= (task.daily_limit || 1)) {
    return res.status(429).json({ error: 'You have already completed this task today' });
  }

  // Anti-fraud: task + user row guard, duplicate pending submission
  const pendingDup = (await completions.all({ where: { user_id: user.id, task_id: task.id, status: 'pending' }, limit: 1 }))[0];
  if (pendingDup) return res.status(429).json({ error: 'You already have a pending submission for this task' });

  const vt = task.verification_type;
  const proof = String(req.body && req.body.proof ? req.body.proof : '').trim();

  if (vt === 'code') {
    if (!proof) return res.status(400).json({ error: 'Verification code required' });
    if (task.verification_code && proof.toUpperCase() !== String(task.verification_code).toUpperCase()) {
      return res.status(400).json({ error: 'Incorrect verification code' });
    }
  }
  if (vt === 'screenshot') {
    if (!proof || !/^data:image\//.test(proof)) return res.status(400).json({ error: 'Screenshot upload required' });
    if (proof.length > 3_000_000) return res.status(400).json({ error: 'Screenshot too large (max ~2MB)' });
  }

  const status = vt === 'code' || vt === 'screenshot' ? 'pending'
    : vt === 'auto' ? 'approved'
    : 'pending'; // manual

  let completion;
  try {
    completion = await completions.create({
      user_id: user.id, task_id: task.id,
      proof: proof ? proof.slice(0, 500000) : null,
      status,
      reward_paid: status === 'approved' ? reward.amount : 0,
      currency_code: reward.currency_code,
      ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').slice(0, 60),
      ua: String(req.headers['user-agent'] || '').slice(0, 200),
    });
  } catch (e) {
    return res.status(500).json({ error: 'Could not save submission' });
  }

  if (status === 'approved') {
    // Auto-verified path → credit instantly via earnings engine.
    // The reward amount recorded on the completion row is the source of truth.
    const engine = require('../services/earnings');
    await engine.approveCompletion({ ...completion, task, user });
    return res.json({
      ok: true, status: 'approved', reward: reward.amount,
      currency_code: reward.currency_code,
      message: `Verified! ${formatMoney(reward.amount, reward.currency_code)} added to your balance.`,
    });
  }

  await notify(user.id, 'Task submitted ⏳', `"${task.title}" received. We'll verify it shortly.`, 'info');
  res.json({ ok: true, status, message: 'Submitted! Verification usually takes a few minutes to 24h.' });
}));

// ── Video watch verification ──────────────────────────────
router.post('/:id/video-verify', requireAuth, wrap(async (req, res) => {
  const task = await tasks.byId(req.params.id);
  if (!task || task.category !== 'video') return res.status(404).json({ error: 'Video task not found' });

  const user = await users.byId(req.user.id);
  if (!isTaskAvailable(task, user)) return res.status(403).json({ error: 'This task is not available in your country' });

  const { session, elapsed } = req.body || {};
  if (!session || !session.startsWith('vwatch-')) return res.status(400).json({ error: 'Invalid watch session' });
  const required = Math.max(parseInt(task.time_required, 10) || 30, 5); // seconds
  if (Number(elapsed) < required) {
    return res.status(400).json({ error: 'Watch the video to the end before claiming' });
  }

  if (await todaysCount(user.id, task.id) >= (task.daily_limit || 1)) {
    return res.status(429).json({ error: 'Already completed this task today' });
  }

  const reward = await resolveReward(task, user);
  const completion = await completions.create({
    user_id: user.id, task_id: task.id,
    proof: `watch:${session}:${elapsed}s`,
    status: 'approved', reward_paid: reward.amount,
    currency_code: reward.currency_code,
  });
  const engine = require('../services/earnings');
  await engine.approveCompletion({ ...completion, task, user });
  res.json({ ok: true, reward: reward.amount, currency_code: reward.currency_code, message: `${formatMoney(reward.amount, reward.currency_code)} added!` });
}));

// Issue a fresh watch session token
router.get('/:id/video-session', requireAuth, wrap(async (req, res) => {
  const task = await tasks.byId(req.params.id);
  if (!task || task.category !== 'video') return res.status(404).json({ error: 'Video task not found' });
  res.json({ session: `vwatch-${crypto.randomBytes(8).toString('hex')}`, seconds: Math.max(parseInt(task.time_required, 10) || 30, 5) });
}));

module.exports = router;
