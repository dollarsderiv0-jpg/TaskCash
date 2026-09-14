/**
 * Earnings engine — credits task rewards and two-level referral commissions.
 * Only ever called for *completed tasks / approved activities*; there is no
 * path in the codebase that credits balances without an underlying activity.
 */
const { Table } = require('../db');
const config = require('../config');
const { r2 } = require('../lib/helpers');
const { formatMoney } = require('../lib/money');
const ws = require('../lib/ws');

const users = new Table('users');
const tasks = new Table('tasks');
const completions = new Table('task_completions');
const referrals = new Table('referrals');
const feed = new Table('earnings_feed');
const notifications = new Table('notifications');

async function notify(userId, title, message, type = 'success') {
  const n = await notifications.create({ user_id: userId, title, message, type });
  ws.sendToUser(userId, { type: 'notification', payload: n });
}

async function pushFeed(user, source, amount, currencyCode) {
  const cur = String(currencyCode || user.currency_code || '').toUpperCase() || null;
  await feed.create({
    user_id: user.id,
    name: user.username ? `${user.username.slice(0, 3)}***` : 'user***',
    source,
    amount: r2(amount),
    currency_code: cur,
  });
  ws.broadcastAll({ type: 'feed', payload: { name: user.username ? `${user.username.slice(0, 3)}***` : 'user***', source, amount: r2(amount), currency_code: cur } });
}

/** Pay referral commissions up the chain (L1 direct, L2 team). */
async function payReferralCommissions(worker, grossReward, source, currencyCode) {
  let payouts = { l1: 0, l2: 0 };
  const isActive = (u) => !u.status || u.status === 'active';
  const l1 = worker.referred_by ? await users.byId(worker.referred_by) : null;
  if (l1 && isActive(l1)) {
    const amt = r2(Number(grossReward) * config.wallet.referralL1Pct);
    if (amt > 0) {
      await users.adjust(l1.id, 'balance', amt);
      await users.adjust(l1.id, 'total_earned', amt);
      await users.adjust(l1.id, 'referral_earnings', amt);
      const rel = await referrals.get({ referrer_id: l1.id, referred_user_id: worker.id });
      if (rel) await referrals.adjust(rel.id, 'commission', amt);
      await notify(l1.id, 'Referral commission', `You earned ${formatMoney(amt, currencyCode)} from ${worker.username}'s task.`, 'success');
      payouts.l1 = amt;

      const l2 = l1.referred_by ? await users.byId(l1.referred_by) : null;
      if (l2 && isActive(l2)) {
        const amt2 = r2(Number(grossReward) * config.wallet.referralL2Pct);
        if (amt2 > 0) {
          await users.adjust(l2.id, 'balance', amt2);
          await users.adjust(l2.id, 'total_earned', amt2);
          await users.adjust(l2.id, 'referral_earnings', amt2);
          const rel2 = await referrals.get({ referrer_id: l2.id, referred_user_id: l1.id });
          if (rel2) await referrals.adjust(rel2.id, 'commission', amt2);
          await notify(l2.id, 'Team commission', `You earned ${formatMoney(amt2, currencyCode)} from your team's activity.`, 'success');
          payouts.l2 = amt2;
        }
      }
    }
  }
  return payouts;
}

/**
 * Approve a task completion: credit reward, feed, referral commissions.
 * `completion` must include task + user rows (or ids).
 */
async function approveCompletion(completion) {
  const task = completion.task_id ? await tasks.byId(completion.task_id) : null;
  const user = await users.byId(completion.user_id);
  if (!task || !user) throw new Error('completion referenced missing task/user');
  // Idempotency: a completion is only ever credited once (reviewed rows are final).
  // Auto-verified tasks are created pre-approved (status='approved', reviewed_at=null).
  if (completion.reviewed_at) return { alreadyApproved: true };

  // Currency of record: the completion row captures the currency at the time
  // of the transaction. It is never converted afterwards.
  const currencyCode = String(completion.currency_code || (completion.user || user).currency_code || user.currency_code || 'KES').toUpperCase();
  const reward = r2(completion.reward_paid || task.reward);
  await users.adjust(user.id, 'balance', reward);
  await users.adjust(user.id, 'total_earned', reward);
  await users.adjust(user.id, 'tasks_completed', 1);
  await completions.update(completion.id, { status: 'approved', reviewed_at: new Date().toISOString() });

  await pushFeed(user, task.category, reward, currencyCode);
  await notify(user.id, 'Task approved 🎉', `"${task.title}" approved — ${formatMoney(reward, currencyCode)} added to your balance.`, 'success');
  await payReferralCommissions(user, reward, task.category, currencyCode);
  return { reward, currency_code: currencyCode };
}

async function rejectCompletion(completion, note) {
  await completions.update(completion.id, {
    status: 'rejected',
    reviewed_at: new Date().toISOString(),
    admin_note: String(note || 'Did not meet verification requirements').slice(0, 300),
  });
  await notify(completion.user_id, 'Task rejected', `Your submission for "${completion.task ? completion.task.title : 'task'}" was rejected. ${note || ''}`.trim(), 'warning');
}

module.exports = { approveCompletion, rejectCompletion, payReferralCommissions, notify, pushFeed };
