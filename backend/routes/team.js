/**
 * My Team / referrals (section 14).
 *
 * Only real data is returned: the code and link belong to the account, the
 * counters come from `referrals`, and rewards come from verified referral
 * ledger entries. No fabricated team members, ever.
 */
const express = require('express');
const { Table } = require('../db');
const config = require('../config');
const { wrap, r2 } = require('../lib/helpers');
const { requireAuth } = require('../middleware/auth');
const ledger = require('../services/ledger');
const settings = require('../services/settings');

const router = express.Router();
const users = new Table('users');
const referrals = new Table('referrals');

async function buildTeam(user) {
  const rows = await referrals.all({ where: { referrer_id: Number(user.id) }, orderBy: 'created_at DESC', limit: 500 });
  const members = [];
  for (const rel of rows) {
    const u = await users.byId(rel.referred_user_id);
    members.push({
      level: rel.level || 1,
      status: rel.qualified_at ? 'active' : 'pending',
      // Only a masked handle is exposed — never another user's identity.
      handle: u && u.username ? `${String(u.username).slice(0, 3)}***` : 'user***',
      commission: r2(rel.commission),
      qualified_at: rel.qualified_at || null,
      joined: u ? u.created_at : rel.created_at,
    });
  }

  const conn = await ledger.history(user.id, { filter: 'all', limit: 500 });
  const rewardTxns = conn.rows.filter((r) => r.type === 'REFERRAL_REWARD' && r.status === 'COMPLETED');
  const rules = await settings.get('referral_rules');

  return {
    code: user.referral_code,
    link: `${config.appUrl}/#/register?ref=${user.referral_code}`,
    currency_code: user.currency_code || config.wallet.currency,
    stats: {
      total_referrals: members.length,
      // "Active" = the referred account completed the eligible condition.
      active_referrals: members.filter((m) => m.status === 'active').length,
      referral_rewards: r2(rewardTxns.reduce((s, r) => s + Number(r.amount || 0), 0)),
    },
    reward_rules: String(rules || '').split('\n').filter(Boolean),
    members: members.slice(0, 100),
  };
}

router.get('/', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(await buildTeam(user));
}));

module.exports = router;
