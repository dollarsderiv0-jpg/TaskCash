/**
 * Home screen data (sections 04, 05).
 * Every number is derived from backend records — today's earnings and watched
 * counts come from the wallet ledger and completed watch sessions.
 */
const express = require('express');
const { Table } = require('../db');
const { wrap, r2 } = require('../lib/helpers');
const { requireAuth } = require('../middleware/auth');
const watch = require('../services/watch');
const ledger = require('../services/ledger');
const settings = require('../services/settings');

const router = express.Router();
const users = new Table('users');
const notifications = new Table('notifications');

router.get('/summary', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const [stats, config, unread] = await Promise.all([
    watch.homeStats(user),
    settings.publicConfig(),
    notifications.count({ user_id: Number(user.id), is_read: false }),
  ]);

  res.json({
    user: {
      fullname: user.fullname,
      first_name: String(user.fullname || '').split(' ')[0],
      phone: user.phone,
      referral_code: user.referral_code,
    },
    stats: { ...stats, currency_code: stats.currency_code || config.currency_code },
    unread_notifications: unread,
    greeting: 'Welcome back 👋',
    subline: 'Watch. Earn. Withdraw.',
    watched_count: Number(user.watched_count || 0),
  });
}));

// Recent ledger activity, used by the wallet screen header refresh.
router.get('/activity', requireAuth, wrap(async (req, res) => {
  const { rows } = await ledger.history(req.user.id, { filter: 'all', limit: 5 });
  res.json({
    transactions: rows.map((r) => ({
      txn_id: r.txn_id,
      type: r.type,
      status: r.status,
      amount: r2(r.amount),
      currency_code: r.currency_code,
      description: r.description,
      created_at: r.created_at,
    })),
  });
}));

module.exports = router;
