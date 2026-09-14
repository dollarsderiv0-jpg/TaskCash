/**
 * One-shot compatibility migration (safe to run on every boot).
 *
 * - Existing users created before the global launch have no country/currency
 *   fields. The platform was Kenya-only, so KE/KES is the documented fallback
 *   (spec §15). New registrations always provide their own country.
 * - Historical transactions (completions/withdrawals/deposits) were all KES,
 *   so they get currency_code = KES. History is never rewritten afterwards.
 */
const { Table, getDb } = require('../db');
const { resolveUserCountry } = require('../lib/countries');

const users = new Table('users');
const completions = new Table('task_completions');
const withdrawals = new Table('withdrawals');
const deposits = new Table('deposits');

async function backfillCurrency(table, rows) {
  for (const row of rows) {
    if (row.currency_code) continue;
    await table.update(row.id, { currency_code: 'KES' });
  }
}

async function run() {
  const legacyUsers = (await users.all({ limit: 5000 })).filter((u) => !u.country_code);
  for (const u of legacyUsers) {
    const name = String(u.country || '').trim();
    // Only the original Kenyan audience maps cleanly; anything else becomes a
    // generic "Unknown" profile instead of being forced to KE.
    const geo = resolveUserCountry('KE');
    const patch = geo
      ? { country: name || geo.country, country_code: geo.country_code, currency: geo.currency, currency_code: geo.currency_code }
      : { country: name || 'Unknown', currency: 'KES', currency_code: 'KES' };
    await users.update(u.id, patch);
  }

  // Historical rows were all KES (pre-global platform).
  await backfillCurrency(completions, await completions.all({ where: { currency_code: null }, limit: 5000 }));
  await backfillCurrency(withdrawals, await withdrawals.all({ where: { currency_code: null }, limit: 5000 }));
  await backfillCurrency(deposits, await deposits.all({ where: { currency_code: null }, limit: 5000 }));

  if (legacyUsers.length) {
    console.log(`[migrate] country/currency backfilled for ${legacyUsers.length} legacy user(s) → KE/KES`);
  }
  return { migrated: legacyUsers.length };
}

module.exports = { run };
