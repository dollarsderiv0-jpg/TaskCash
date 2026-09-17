/**
 * Notifications (section 16).
 *
 * Rows are only created by server-side events — verified deposits, validated
 * watch rewards, payout status changes, referral rewards and security events.
 * Unread state is per user and per row.
 */
const express = require('express');
const { Table } = require('../db');
const { wrap } = require('../lib/helpers');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const notifications = new Table('notifications');

router.get('/', requireAuth, wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const mine = await notifications.all({ where: { user_id: Number(req.user.id) }, orderBy: 'created_at DESC', limit });
  const broadcast = await notifications.all({ where: { user_id: null }, orderBy: 'created_at DESC', limit: 10 });

  const rows = [...mine, ...broadcast]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);

  res.json({
    notifications: rows.map((n) => ({
      id: n.id,
      title: n.title,
      message: n.message,
      type: n.type,
      is_read: Boolean(n.is_read),
      link: n.link || null,
      created_at: n.created_at,
    })),
    unread: mine.filter((n) => !n.is_read).length,
  });
}));

router.post('/:id/read', requireAuth, wrap(async (req, res) => {
  const row = await notifications.byId(req.params.id);
  if (!row || (row.user_id != null && Number(row.user_id) !== Number(req.user.id))) {
    return res.status(404).json({ error: 'Notification not found' });
  }
  if (!row.is_read) await notifications.update(row.id, { is_read: true });
  res.json({ ok: true });
}));

router.post('/read-all', requireAuth, wrap(async (req, res) => {
  const mine = await notifications.all({ where: { user_id: Number(req.user.id) }, limit: 300 });
  for (const n of mine) if (!n.is_read) await notifications.update(n.id, { is_read: true });
  res.json({ ok: true, updated: mine.length });
}));

module.exports = router;
