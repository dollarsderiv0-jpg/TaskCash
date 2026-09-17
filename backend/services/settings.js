/**
 * Platform settings (sections 11, 15, 21).
 *
 * Values an operator can change live from the admin console. Environment
 * variables provide the defaults, rows in `app_settings` override them, and
 * the public subset is what the mobile app is allowed to display.
 */
const { Table } = require('../db');
const config = require('../config');
const { r2 } = require('../lib/helpers');

const settingsTable = new Table('app_settings');

const NUMERIC_KEYS = [
  'min_withdrawal', 'withdrawal_fee_pct', 'min_deposit', 'max_deposit',
  'watch_daily_limit', 'watch_required_pct', 'referral_reward',
];

const DEFAULTS = {
  brand_name: config.brand,
  support_email: process.env.SUPPORT_EMAIL || 'support@watchrewards.app',
  min_withdrawal: config.wallet.minWithdrawal,
  withdrawal_fee_pct: config.wallet.withdrawalFeePct,
  expected_processing: config.wallet.expectedProcessing,
  min_deposit: config.payments.minDeposit,
  max_deposit: config.payments.maxDeposit,
  watch_daily_limit: config.watch.dailyLimit,
  watch_required_pct: config.watch.requiredPct,
  referral_reward: config.watch.referralReward,
  referral_rules: [
    'Share your referral link.',
    'A new user registers through your link.',
    'Eligible referral conditions are completed.',
    'Any applicable reward is credited according to the published rules.',
  ].join('\n'),
  maintenance_message: '',
};

/** Coerce a stored/patched value to the right type. */
function coerce(key, value) {
  if (value === undefined || value === null || value === '') return null;
  if (NUMERIC_KEYS.includes(key)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return String(value).slice(0, 2000);
}

async function getAll() {
  const rows = await settingsTable.all({ limit: 200 });
  const out = { ...DEFAULTS };
  for (const row of rows) {
    const value = coerce(row.key, row.value);
    if (value !== null) out[row.key] = value;
  }
  return out;
}

async function get(key) {
  const row = await settingsTable.get({ key });
  const value = row ? coerce(key, row.value) : null;
  return value === null ? DEFAULTS[key] : value;
}

/** Numbers are always returned as numbers, never as strings. */
async function getNumber(key) {
  const value = await get(key);
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Operator update. Writes only known keys and returns the merged result. */
async function update(patch, actorId = null) {
  const applied = {};
  for (const [key, raw] of Object.entries(patch || {})) {
    if (!(key in DEFAULTS)) continue;
    const value = coerce(key, raw);
    if (value === null) continue;
    const existing = await settingsTable.get({ key });
    if (existing) await settingsTable.update(existing.id, { value: String(value), updated_at: new Date().toISOString() });
    else await settingsTable.create({ key, value: String(value) });
    applied[key] = value;
  }
  if (actorId) {
    const ledger = require('./ledger');
    await ledger.audit({
      actorId,
      actorRole: 'admin',
      action: 'settings.update',
      targetType: 'app_settings',
      detail: JSON.stringify(applied),
    });
  }
  return { applied, settings: await getAll() };
}

/** The subset of settings the mobile app may read (no secrets, no ops text). */
async function publicConfig() {
  const s = await getAll();
  const payments = require('./payments');
  return {
    brand: s.brand_name,
    tagline: config.tagline,
    currency_code: config.wallet.currency,
    min_withdrawal: r2(s.min_withdrawal),
    withdrawal_fee_pct: r2(s.withdrawal_fee_pct),
    expected_processing: s.expected_processing,
    min_deposit: r2(s.min_deposit),
    max_deposit: r2(s.max_deposit),
    watch: {
      daily_limit: Number(s.watch_daily_limit),
      required_pct: Number(s.watch_required_pct),
    },
    referral: {
      reward: r2(s.referral_reward),
      currency_code: config.wallet.currency,
      rules: String(s.referral_rules || '').split('\n').filter(Boolean),
    },
    support_email: s.support_email,
    payment_provider: payments.describe(),
  };
}

module.exports = { DEFAULTS, NUMERIC_KEYS, getAll, get, getNumber, update, publicConfig };
