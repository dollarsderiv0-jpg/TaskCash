const express = require('express');
const { Table } = require('../db');
const config = require('../config');
const { wrap, r2 } = require('../lib/helpers');
const { requireAuth } = require('../middleware/auth');
const ws = require('../lib/ws');
const { notify } = require('../services/earnings');

const router = express.Router();
const notifications = new Table('notifications');
const users = new Table('users');
const referrals = new Table('referrals');
const tickets = new Table('support_tickets');
const ticketMessages = new Table('ticket_messages');
const announcements = new Table('announcements');
const chat = new Table('live_chat_messages');

// ── Notifications ─────────────────────────────────────────
router.get('/', requireAuth, wrap(async (req, res) => {
  const mine = await notifications.all({ where: { user_id: req.user.id }, orderBy: 'created_at DESC', limit: 40 });
  const broadcast = await notifications.all({ where: { user_id: null }, orderBy: 'created_at DESC', limit: 10 });
  res.json({ notifications: [...mine, ...broadcast].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 50) });
}));

router.post('/read-all', requireAuth, wrap(async (req, res) => {
  const db = require('../db').getDb();
  if (db.mode === 'pg') {
    await db.raw('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.user.id]);
  } else {
    const mine = await notifications.all({ where: { user_id: req.user.id } });
    for (const n of await Promise.resolve(mine)) await notifications.update(n.id, { is_read: true });
  }
  res.json({ ok: true });
}));

// ── Referrals ─────────────────────────────────────────────
router.get('/referrals', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  const rows = await referrals.all({ where: { referrer_id: req.user.id }, orderBy: 'created_at DESC', limit: 200 });
  const l1 = []; const l2 = [];
  for (const rel of rows) {
    if (rel.level === 1) {
      const u = await users.byId(rel.referred_user_id);
      if (u) l1.push({ id: u.id, username: u.username ? `${u.username.slice(0, 3)}***` : 'user***', joined: u.created_at, commission: r2(rel.commission), status: u.status });
    } else {
      const u = await users.byId(rel.referred_user_id);
      if (u) l2.push({ id: u.id, username: u.username ? `${u.username.slice(0, 3)}***` : 'user***', joined: u.created_at, commission: r2(rel.commission) });
    }
  }
  res.json({
    code: user.referral_code,
    link: `${config.appUrl}/register.html?ref=${user.referral_code}`,
    stats: {
      l1_count: l1.length,
      l2_count: l2.length,
      total_earned: r2(user.referral_earnings),
      rates: { l1: '10%', l2: '3%' },
    },
    l1, l2,
  });
}));

// ── Support tickets ───────────────────────────────────────
router.get('/tickets', requireAuth, wrap(async (req, res) => {
  const rows = await tickets.all({ where: { user_id: req.user.id }, orderBy: 'updated_at DESC', limit: 30 });
  res.json({ tickets: rows });
}));

router.post('/tickets', requireAuth, wrap(async (req, res) => {
  const subject = String(req.body.subject || '').trim().slice(0, 160);
  const message = String(req.body.message || '').trim().slice(0, 4000);
  if (!subject || !message) return res.status(400).json({ error: 'Subject and message required' });

  const t = await tickets.create({ user_id: req.user.id, subject, status: 'open' });
  await ticketMessages.create({ ticket_id: t.id, sender_id: req.user.id, sender_role: 'user', message });
  ws.broadcastAdmins({ type: 'admin_alert', payload: { kind: 'ticket', id: t.id } });
  res.json({ ok: true, ticket: t });
}));

router.get('/tickets/:id', requireAuth, wrap(async (req, res) => {
  const t = await tickets.byId(req.params.id);
  if (!t || (t.user_id !== req.user.id && req.user.role !== 'admin')) return res.status(404).json({ error: 'Ticket not found' });
  const msgs = await ticketMessages.all({ where: { ticket_id: t.id }, orderBy: 'created_at ASC', limit: 100 });
  res.json({ ticket: t, messages: msgs });
}));

router.post('/tickets/:id/reply', requireAuth, wrap(async (req, res) => {
  const t = await tickets.byId(req.params.id);
  if (!t || (t.user_id !== req.user.id && req.user.role !== 'admin')) return res.status(404).json({ error: 'Ticket not found' });
  const message = String(req.body.message || '').trim().slice(0, 4000);
  if (!message) return res.status(400).json({ error: 'Message required' });

  await ticketMessages.create({ ticket_id: t.id, sender_id: req.user.id, sender_role: req.user.role, message });
  await tickets.update(t.id, { status: req.user.role === 'admin' ? 'answered' : 'open', updated_at: new Date().toISOString() });
  if (req.user.role === 'admin' && t.user_id !== req.user.id) {
    await notify(t.user_id, 'Support replied 💬', `Re: "${t.subject}"`, 'info');
  }
  res.json({ ok: true });
}));

// ── Announcements ─────────────────────────────────────────
router.get('/announcements', wrap(async (_req, res) => {
  const rows = await announcements.all({ where: { is_active: true }, orderBy: 'created_at DESC', limit: 15 });
  res.json({ announcements: rows });
}));

// ── Live chat (public room, WS broadcast) ─────────────────
router.get('/chat', wrap(async (_req, res) => {
  const rows = await chat.all({ orderBy: 'created_at DESC', limit: 40 });
  res.json({ messages: rows.reverse() });
}));

router.post('/chat', wrap(async (req, res) => {
  const message = String(req.body.message || '').trim().slice(0, 500);
  if (!message) return res.status(400).json({ error: 'Message required' });
  const name = req.user ? (req.user.username || 'user') : (String(req.body.name || 'Guest').slice(0, 30) || 'Guest');
  const role = req.user ? req.user.role : 'guest';
  const m = await chat.create({ user_id: req.user ? req.user.id : null, name: name ? `${name.slice(0, 3)}***` : 'Gue***', role, message });
  ws.broadcastAll({ type: 'chat', payload: m });
  res.json({ ok: true, message: m });
}));

module.exports = router;
