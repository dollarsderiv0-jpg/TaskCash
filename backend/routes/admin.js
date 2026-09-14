const express = require('express');
const { Table } = require('../db');
const { wrap, r2, txnRef } = require('../lib/helpers');
const { requireAdmin } = require('../middleware/auth');
const { notify, approveCompletion, rejectCompletion } = require('../services/earnings');
const kyc = require('../services/kyc');
const ws = require('../lib/ws');

const router = express.Router();
router.use(requireAdmin);

const users = new Table('users');
const tasks = new Table('tasks');
const completions = new Table('task_completions');
const deposits = new Table('deposits');
const withdrawals = new Table('withdrawals');
const packages = new Table('packages');
const promos = new Table('promo_codes');
const announcements = new Table('announcements');
const tickets = new Table('support_tickets');
const notifications = new Table('notifications');

// ── Users ─────────────────────────────────────────────────
router.get('/users', wrap(async (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  let rows = await users.all({ orderBy: 'created_at DESC', limit: 500 });
  if (q) rows = rows.filter((u) =>
    (u.username || '').toLowerCase().includes(q) ||
    (u.email || '').toLowerCase().includes(q) ||
    (u.fullname || '').toLowerCase().includes(q) ||
    (u.phone || '').includes(q));
  res.json({
    users: rows.slice(0, 200).map((u) => ({
      id: u.id, fullname: u.fullname, username: u.username, email: u.email, phone: u.phone,
      balance: r2(u.balance), pending_balance: r2(u.pending_balance), total_earned: r2(u.total_earned),
      status: u.status, role: u.role, kyc_status: u.kyc_status, email_verified: u.email_verified,
      tasks_completed: u.tasks_completed, created_at: u.created_at, package_id: u.package_id,
    })),
  });
}));

router.get('/users/:id', wrap(async (req, res) => {
  const u = await users.byId(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ user: { ...u, password_hash: undefined, kyc_docs: undefined, balance: r2(u.balance), pending_balance: r2(u.pending_balance) } });
}));

router.post('/users/:id/suspend', wrap(async (req, res) => {
  const u = await users.byId(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.role === 'admin') return res.status(400).json({ error: 'Cannot suspend an admin' });
  const status = u.status === 'suspended' ? 'active' : 'suspended';
  await users.update(u.id, { status });
  await notify(u.id, status === 'suspended' ? 'Account suspended' : 'Account reinstated',
    status === 'suspended' ? 'Your account was suspended for policy review. Contact support.' : 'Welcome back! Your account is active again.',
    status === 'suspended' ? 'danger' : 'success');
  res.json({ ok: true, status });
}));

router.post('/users/:id/adjust-balance', wrap(async (req, res) => {
  const u = await users.byId(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const delta = r2(Number(req.body.delta || 0));
  if (!delta) return res.status(400).json({ error: 'Provide a non-zero delta' });
  await users.adjust(u.id, 'balance', delta);
  await users.adjust(u.id, 'total_earned', Math.max(delta, 0));
  await notify(u.id, 'Balance adjusted', `Support ${delta > 0 ? 'credited' : 'debited'} KES ${Math.abs(delta).toFixed(2)} ${delta > 0 ? 'to' : 'from'} your wallet.`, delta > 0 ? 'success' : 'warning');
  res.json({ ok: true, balance: r2((await users.byId(u.id)).balance) });
}));

// ── KYC review ────────────────────────────────────────────
router.get('/kyc', wrap(async (_req, res) => {
  const rows = await users.all({ where: { kyc_status: 'pending' }, limit: 100 });
  res.json({ pending: rows.map((u) => ({ id: u.id, username: u.username, fullname: u.fullname, email: u.email, submitted: u.updated_at })) });
}));

router.post('/kyc/:userId/:decision', wrap(async (req, res) => {
  const decision = req.params.decision === 'approve' ? 'approve' : 'reject';
  const out = await kyc.review(Number(req.params.userId), decision, req.user.id);
  await notify(out.user_id, decision === 'approve' ? 'Account verified ✅' : 'Verification declined',
    decision === 'approve' ? 'Your KYC was approved — withdrawals unlocked!' : 'We could not verify your documents. Please resubmit.',
    decision === 'approve' ? 'success' : 'warning');
  res.json({ ok: true, ...out });
}));

// ── Withdrawals ───────────────────────────────────────────
router.get('/withdrawals', wrap(async (req, res) => {
  const status = req.query.status ? { status: String(req.query.status) } : {};
  const rows = await withdrawals.all({ where: status, orderBy: 'created_at DESC', limit: 100 });
  const out = [];
  for (const w of rows) {
    const u = await users.byId(w.user_id);
    out.push({ ...w, amount: r2(w.amount), fee: r2(w.fee), net_amount: r2(w.net_amount), username: u ? u.username : '?' });
  }
  res.json({ withdrawals: out });
}));

router.post('/withdrawals/:id/approve', wrap(async (req, res) => {
  const w = await withdrawals.byId(req.params.id);
  if (!w || w.status !== 'pending') return res.status(404).json({ error: 'Pending withdrawal not found' });

  // NOTE: M-Pesa B2C payout API call goes here in live mode using the
  // configured credentials. In demo/manual mode the admin marks it paid.
  await withdrawals.update(w.id, {
    status: 'approved',
    reviewed_by: req.user.id,
    reviewed_at: new Date().toISOString(),
    reference: txnRef('W'),
  });
  await users.adjust(w.user_id, 'pending_balance', -Number(w.amount));
  await notify(w.user_id, 'Withdrawal approved 💸', `KES ${r2(w.net_amount).toFixed(2)} sent via ${w.method === 'mpesa' ? 'M-Pesa' : 'bank transfer'}. Reference ${w.reference}.`, 'success');
  ws.broadcastAdmins({ type: 'admin_alert', payload: { kind: 'withdrawal_done', id: w.id } });
  res.json({ ok: true });
}));

router.post('/withdrawals/:id/reject', wrap(async (req, res) => {
  const w = await withdrawals.byId(req.params.id);
  if (!w || w.status !== 'pending') return res.status(404).json({ error: 'Pending withdrawal not found' });
  await withdrawals.update(w.id, {
    status: 'rejected', reviewed_by: req.user.id, reviewed_at: new Date().toISOString(),
    admin_note: String(req.body.note || 'Did not pass review').slice(0, 300),
  });
  await users.adjust(w.user_id, 'pending_balance', -Number(w.amount));
  await users.adjust(w.user_id, 'balance', Number(w.amount));
  await notify(w.user_id, 'Withdrawal rejected', `${String(req.body.note || 'Did not pass review').slice(0, 200)} Funds returned to your balance.`, 'warning');
  res.json({ ok: true });
}));

// ── Deposits ──────────────────────────────────────────────
router.get('/deposits', wrap(async (req, res) => {
  const status = req.query.status ? { status: String(req.query.status) } : {};
  const rows = await deposits.all({ where: status, orderBy: 'created_at DESC', limit: 100 });
  const out = [];
  for (const d of rows) {
    const u = await users.byId(d.user_id);
    out.push({ ...d, amount: r2(d.amount), username: u ? u.username : '?' });
  }
  res.json({ deposits: out });
}));

router.post('/deposits/:id/approve', wrap(async (req, res) => {
  const d = await deposits.byId(req.params.id);
  if (!d || d.status !== 'pending') return res.status(404).json({ error: 'Pending deposit not found' });
  await deposits.update(d.id, { status: 'approved', reviewed_by: req.user.id, reviewed_at: new Date().toISOString(), reference: txnRef('D') });
  await users.adjust(d.user_id, 'balance', r2(d.amount));
  await notify(d.user_id, 'Deposit approved ✅', `KES ${r2(d.amount).toFixed(2)} added to your balance.`, 'success');
  res.json({ ok: true });
}));

router.post('/deposits/:id/reject', wrap(async (req, res) => {
  const d = await deposits.byId(req.params.id);
  if (!d || d.status !== 'pending') return res.status(404).json({ error: 'Pending deposit not found' });
  await deposits.update(d.id, { status: 'rejected', reviewed_by: req.user.id, reviewed_at: new Date().toISOString() });
  res.json({ ok: true });
}));

// ── Tasks CRUD ────────────────────────────────────────────
router.get('/tasks', wrap(async (_req, res) => {
  const rows = await tasks.all({ orderBy: 'created_at DESC', limit: 300 });
  res.json({ tasks: rows.map((t) => ({ ...t, reward: r2(t.reward) })) });
}));

router.post('/tasks', wrap(async (req, res) => {
  const { title, description, category, reward, time_required, verification_type, url, instructions, min_package, daily_limit, verification_code } = req.body || {};
  if (!title || !description || !reward) return res.status(400).json({ error: 'Title, description and reward are required' });
  const t = await tasks.create({
    title: String(title).slice(0, 160),
    description: String(description).slice(0, 4000),
    category: String(category || 'website').slice(0, 40),
    reward: r2(reward),
    time_required: time_required ? String(time_required).slice(0, 40) : null,
    verification_type: ['code', 'screenshot', 'manual', 'auto'].includes(verification_type) ? verification_type : 'manual',
    url: url ? String(url).slice(0, 500) : null,
    instructions: instructions ? String(instructions).slice(0, 2000) : null,
    min_package: min_package || null,
    daily_limit: Math.max(parseInt(daily_limit, 10) || 1, 1),
    verification_code: verification_code ? String(verification_code).slice(0, 20).toUpperCase() : null,
    created_by: req.user.id,
  });
  res.json({ ok: true, task: t });
}));

router.put('/tasks/:id', wrap(async (req, res) => {
  const t = await tasks.byId(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const patch = {};
  for (const k of ['title', 'description', 'category', 'time_required', 'url', 'instructions', 'min_package', 'verification_code']) {
    if (req.body[k] !== undefined) patch[k] = req.body[k] === null ? null : String(req.body[k]).slice(0, 4000);
  }
  if (req.body.reward !== undefined) patch.reward = r2(req.body.reward);
  if (req.body.daily_limit !== undefined) patch.daily_limit = Math.max(parseInt(req.body.daily_limit, 10) || 1, 1);
  if (req.body.verification_type && ['code', 'screenshot', 'manual', 'auto'].includes(req.body.verification_type)) patch.verification_type = req.body.verification_type;
  if (req.body.status && ['active', 'inactive'].includes(req.body.status)) patch.status = req.body.status;
  await tasks.update(t.id, patch);
  res.json({ ok: true, task: await tasks.byId(t.id) });
}));

router.delete('/tasks/:id', wrap(async (req, res) => {
  await tasks.delete(req.params.id);
  res.json({ ok: true });
}));

// ── Task completions review ───────────────────────────────
router.get('/completions', wrap(async (req, res) => {
  const where = req.query.status ? { status: String(req.query.status) } : {};
  const rows = await completions.all({ where, orderBy: 'created_at DESC', limit: 100 });
  const out = [];
  for (const c of rows) {
    const t = c.task_id ? await tasks.byId(c.task_id) : null;
    const u = await users.byId(c.user_id);
    out.push({
      id: c.id, user: u ? u.username : '?', task: t ? t.title : 'Daily check-in',
      status: c.status, proof: c.proof, reward: t ? r2(t.reward) : r2(c.reward_paid),
      created_at: c.created_at, task_id: c.task_id, user_id: c.user_id,
    });
  }
  res.json({ completions: out });
}));

router.post('/completions/:id/approve', wrap(async (req, res) => {
  const c = await completions.byId(req.params.id);
  if (!c) return res.status(404).json({ error: 'Submission not found' });
  if (c.status !== 'pending') return res.status(400).json({ error: 'Already reviewed' });
  const result = await approveCompletion(c);
  res.json({ ok: true, ...result });
}));

router.post('/completions/:id/reject', wrap(async (req, res) => {
  const c = await completions.byId(req.params.id);
  if (!c) return res.status(404).json({ error: 'Submission not found' });
  if (c.status !== 'pending') return res.status(400).json({ error: 'Already reviewed' });
  await rejectCompletion(c, req.body && req.body.note);
  res.json({ ok: true });
}));

// ── Packages ──────────────────────────────────────────────
router.get('/packages', wrap(async (_req, res) => {
  res.json({ packages: (await packages.all({ orderBy: 'price ASC' })).map((p) => ({ ...p, price: r2(p.price) })) });
}));

router.post('/packages', wrap(async (req, res) => {
  const { name, price, daily_tasks, benefits, duration_days } = req.body || {};
  if (!name || !price) return res.status(400).json({ error: 'Name and price required' });
  const p = await packages.create({
    name: String(name).slice(0, 40), price: r2(price),
    daily_tasks: Math.max(parseInt(daily_tasks, 10) || 3, 1),
    benefits: benefits ? String(benefits).slice(0, 2000) : null,
    duration_days: Math.max(parseInt(duration_days, 10) || 30, 1),
  });
  res.json({ ok: true, package: p });
}));

router.put('/packages/:id', wrap(async (req, res) => {
  const p = await packages.byId(req.params.id);
  if (!p) return res.status(404).json({ error: 'Package not found' });
  const patch = {};
  if (req.body.name) patch.name = String(req.body.name).slice(0, 40);
  if (req.body.price !== undefined) patch.price = r2(req.body.price);
  if (req.body.daily_tasks !== undefined) patch.daily_tasks = Math.max(parseInt(req.body.daily_tasks, 10) || 3, 1);
  if (req.body.benefits !== undefined) patch.benefits = String(req.body.benefits || '').slice(0, 2000);
  if (req.body.duration_days !== undefined) patch.duration_days = Math.max(parseInt(req.body.duration_days, 10) || 30, 1);
  if (req.body.is_active !== undefined) patch.is_active = Boolean(req.body.is_active);
  await packages.update(p.id, patch);
  res.json({ ok: true, package: await packages.byId(p.id) });
}));

// ── Promo codes ───────────────────────────────────────────
router.get('/promos', wrap(async (_req, res) => {
  res.json({ promos: await promos.all({ orderBy: 'created_at DESC', limit: 100 }) });
}));

router.post('/promos', wrap(async (req, res) => {
  const { code, amount, max_uses, expires_at } = req.body || {};
  if (!code || !amount) return res.status(400).json({ error: 'Code and amount required' });
  const p = await promos.create({
    code: String(code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20),
    amount: r2(amount),
    max_uses: Math.max(parseInt(max_uses, 10) || 100, 1),
    expires_at: expires_at || null,
  });
  res.json({ ok: true, promo: p });
}));

router.delete('/promos/:id', wrap(async (req, res) => {
  await promos.delete(req.params.id);
  res.json({ ok: true });
}));

// ── Announcements / banners ───────────────────────────────
router.get('/announcements', wrap(async (_req, res) => {
  res.json({ announcements: await announcements.all({ orderBy: 'created_at DESC', limit: 50 }) });
}));

router.post('/announcements', wrap(async (req, res) => {
  const { title, body, banner_url, link } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'Title and body required' });
  const a = await announcements.create({
    title: String(title).slice(0, 160), body: String(body).slice(0, 4000),
    banner_url: banner_url ? String(banner_url).slice(0, 500) : null,
    link: link ? String(link).slice(0, 500) : null,
  });
  ws.broadcastAll({ type: 'announcement', payload: a });
  res.json({ ok: true, announcement: a });
}));

router.delete('/announcements/:id', wrap(async (req, res) => {
  await announcements.delete(req.params.id);
  res.json({ ok: true });
}));

// ── Broadcast notifications ───────────────────────────────
router.post('/broadcast', wrap(async (req, res) => {
  const { title, message, type } = req.body || {};
  if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
  const n = await notifications.create({
    user_id: null, title: String(title).slice(0, 160), message: String(message).slice(0, 2000),
    type: ['info', 'success', 'warning', 'danger'].includes(type) ? type : 'info',
  });
  ws.broadcastAll({ type: 'notification', payload: n });
  res.json({ ok: true, notification: n });
}));

// ── Support tickets ───────────────────────────────────────
router.get('/tickets', wrap(async (req, res) => {
  const where = req.query.status ? { status: String(req.query.status) } : {};
  const rows = await tickets.all({ where, orderBy: 'updated_at DESC', limit: 100 });
  const out = [];
  for (const t of rows) {
    const u = await users.byId(t.user_id);
    out.push({ ...t, username: u ? u.username : '?' });
  }
  res.json({ tickets: out });
}));

module.exports = router;
