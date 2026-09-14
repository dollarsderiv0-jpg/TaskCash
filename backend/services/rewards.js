/**
 * Country-specific reward engine.
 *
 * A reward is defined by (task, country, currency, amount) — configured per
 * country in the task_rewards table. Rewards are NEVER converted using
 * exchange rates: KE → 500 KES and US → 5 USD are separate configured rows.
 *
 * Fallback: if a task has no task_rewards rows, the legacy `tasks.reward`
 * column is used as a global reward (charged in the user's account currency).
 */
const { Table } = require('../db');
const { r2 } = require('../lib/helpers');
const { getCountry } = require('../lib/countries');

const taskRewards = new Table('task_rewards');

/**
 * Resolve the reward applicable to a user for a task.
 * Priority: exact country row → global task reward (user's currency).
 * Returns { amount, currency_code, source } or null if unresolvable.
 */
async function resolveReward(task, user) {
  const countryCode = String(user.country_code || '').toUpperCase();
  const currencyCode = String(user.currency_code || '').toUpperCase();

  if (countryCode) {
    const row = await taskRewards.get({ task_id: task.id, country_code: countryCode });
    if (row) {
      return {
        amount: r2(row.reward_amount),
        currency_code: String(row.currency_code || currencyCode).toUpperCase(),
        source: 'country',
      };
    }
  }
  return {
    amount: r2(task.reward),
    currency_code: currencyCode || 'KES',
    source: 'global',
  };
}

/**
 * Validate a full rewards payload for admin create/update:
 * { rewards: [{ country_code, reward_amount }] }
 * Throws on invalid country codes or non-numeric amounts.
 */
function validateRewardsPayload(rewards) {
  if (rewards === undefined || rewards === null) return [];
  if (!Array.isArray(rewards)) throw new Error('rewards must be an array');
  const seen = new Set();
  const out = rewards.map((r) => {
    const cc = String(r.country_code || '').toUpperCase();
    const country = getCountry(cc);
    if (!country) throw new Error(`Unknown country code: ${cc}`);
    if (seen.has(cc)) throw new Error(`Duplicate country reward: ${cc}`);
    seen.add(cc);
    const amount = r2(r.reward_amount);
    if (!(amount > 0)) throw new Error(`Reward amount for ${cc} must be a positive number`);
    return { country_code: cc, currency_code: country.currency_code, reward_amount: amount };
  });
  return out;
}

/**
 * Replace all per-country rewards for a task with the given payload.
 */
async function setTaskRewards(taskId, rewards) {
  const existing = await taskRewards.all({ where: { task_id: taskId } });
  for (const row of existing) await taskRewards.delete(row.id);
  for (const r of rewards) {
    await taskRewards.create({
      task_id: taskId,
      country_code: r.country_code,
      currency_code: r.currency_code,
      reward_amount: r.reward_amount,
    });
  }
}

/** All configured rewards for a task (admin display). */
function getTaskRewards(taskId) {
  return taskRewards.all({ where: { task_id: taskId }, orderBy: 'country_code ASC' });
}

/**
 * Task availability check for a user's country.
 * availability_type: 'global' | 'countries' (with countries: ['KE', ...] —
 * stored as a JSON string column, parsed defensively here).
 */
function isTaskAvailable(task, user) {
  const type = task.availability_type || 'global';
  if (type === 'global') return true;
  let list = task.countries;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = []; }
  }
  if (!Array.isArray(list)) list = [];
  return list.map((c) => String(c).toUpperCase()).includes(String(user.country_code || '').toUpperCase());
}

module.exports = { resolveReward, validateRewardsPayload, setTaskRewards, getTaskRewards, isTaskAvailable };
