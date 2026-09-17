/**
 * WATCHREWARDS — wallet ledger.
 *
 * The single place where money moves. Rules enforced here:
 *   1. Every movement writes an immutable row to `wallet_transactions`.
 *   2. A client-supplied balance is never trusted — balances are only ever
 *      derived from ledger operations against server-side records.
 *   3. `idempotency_key` is unique: replaying a provider callback (or a
 *      double-tapped claim) returns the original transaction instead of
 *      crediting twice.
 *   4. Rows are never deleted and a COMPLETED row can only move to REVERSED,
 *      which writes a compensating REVERSAL entry.
 *
 * Direction is derived from `type`:
 *   credit — DEPOSIT, WATCH_REWARD, REFERRAL_REWARD, REVERSAL
 *   debit  — WITHDRAWAL, FEE
 */
const { Table, getDb } = require('../db');
const config = require('../config');
const { r2, txnRef } = require('../lib/helpers');

const users = new Table('users');
const ledger = new Table('wallet_transactions');

const TYPES = ['DEPOSIT', 'WATCH_REWARD', 'REFERRAL_REWARD', 'WITHDRAWAL', 'FEE', 'REVERSAL'];
const STATUSES = ['PENDING', 'COMPLETED', 'FAILED', 'REVERSED'];
const CREDIT_TYPES = ['DEPOSIT', 'WATCH_REWARD', 'REFERRAL_REWARD', 'REVERSAL'];
const DIRECTION = Object.fromEntries(TYPES.map((t) => [t, CREDIT_TYPES.includes(t) ? 'credit' : 'debit']));

const isCredit = (type) => DIRECTION[type] === 'credit';

/** Human-facing unique transaction id, e.g. WRTX-4F9K2A7C1D. */
function newTxnId() { return txnRef('WRTX-'); }

function validate({ type, status, amount }) {
  if (!TYPES.includes(type)) throw Object.assign(new Error(`Unknown transaction type: ${type}`), { status: 400 });
  if (status && !STATUSES.includes(status)) throw Object.assign(new Error(`Unknown transaction status: ${status}`), { status: 400 });
  if (!(Number(amount) > 0)) throw Object.assign(new Error('Transaction amount must be greater than zero'), { status: 400 });
}

async function byIdempotencyKey(key) {
  if (!key) return null;
  return ledger.get({ idempotency_key: key });
}

async function applyBalance(user, type, amount) {
  const delta = isCredit(type) ? r2(amount) : -r2(amount);
  const fields = { balance: delta };
  // Lifetime counters are derived from completed movements only.
  if (type === 'DEPOSIT') fields.total_deposited = r2(amount);
  if (type === 'WITHDRAWAL') fields.total_withdrawn = r2(amount);
  if (type === 'WATCH_REWARD' || type === 'REFERRAL_REWARD') fields.total_earned = r2(amount);

  let updated = user;
  for (const [field, value] of Object.entries(fields)) {
    updated = (await users.adjust(user.id, field, value)) || updated;
  }
  return updated;
}

/**
 * Record a ledger entry.
 *
 * @param {object} opts
 * @param {number} opts.userId
 * @param {string} opts.type        one of TYPES
 * @param {number} opts.amount      positive magnitude
 * @param {string} [opts.status]    PENDING (default) | COMPLETED | FAILED
 * @param {string} [opts.description]
 * @param {string} [opts.reference]
 * @param {string} [opts.provider]
 * @param {string} [opts.providerRef]
 * @param {string} [opts.idempotencyKey]  replay-safe key
 * @param {object} [opts.metadata]
 * @param {number} [opts.balanceOverride] balance to store on the row
 * @param {boolean} [opts.informational] record a COMPLETED row without moving
 *        the balance (used for fees, which are already inside the amount that
 *        was debited for the parent transaction)
 * @returns {{ transaction: object, balance: number, duplicate: boolean }}
 */
async function record(opts) {
  const {
    userId, type, amount, status = 'PENDING', description = '', reference = null,
    provider = null, providerRef = null, idempotencyKey = null, metadata = null,
    balanceOverride = null, informational = false,
  } = opts || {};
  validate({ type, status, amount });

  const user = await users.byId(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });

  // Replay protection: return the original row, never a second credit.
  const existing = await byIdempotencyKey(idempotencyKey);
  if (existing) {
    return { transaction: existing, balance: Number(user.balance || 0), duplicate: true };
  }

  const row = await ledger.create({
    txn_id: newTxnId(),
    user_id: Number(user.id),
    type,
    status,
    amount: r2(amount),
    currency_code: String(user.currency_code || config.wallet.currency).toUpperCase(),
    description: String(description).slice(0, 200),
    reference,
    provider,
    provider_ref: providerRef,
    idempotency_key: idempotencyKey,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });

  // A PENDING entry is a reservation, not money in the wallet.
  if (status !== 'COMPLETED') {
    return { transaction: row, balance: Number(user.balance || 0), duplicate: false };
  }

  // Informational entries describe money that was already moved by another
  // row (a payout fee sits inside the withdrawn gross). They must not move the
  // balance a second time.
  if (informational) {
    const info = await ledger.update(row.id, {
      balance_after: r2(user.balance),
      metadata: JSON.stringify({ ...(metadata || {}), informational: true }),
      updated_at: new Date().toISOString(),
    });
    return { transaction: info, balance: r2(user.balance), duplicate: false };
  }

  const updated = await applyBalance(user, type, amount);
  const done = await ledger.update(row.id, {
    balance_after: balanceOverride != null ? r2(balanceOverride) : r2(updated.balance),
    updated_at: new Date().toISOString(),
  });
  return { transaction: done, balance: r2(updated.balance), duplicate: false };
}

/** Credit helper (DEPOSIT / WATCH_REWARD / REFERRAL_REWARD). */
function credit(opts) { return record({ ...opts, status: opts.status || 'COMPLETED' }); }

/** Debit helper (WITHDRAWAL / FEE). Debits are reservations until COMPLETED. */
function debit(opts) { return record(opts); }

function metadataOf(row) {
  try { return JSON.parse(row.metadata || '{}') || {}; } catch { return {}; }
}
const isReserved = (row) => Boolean(metadataOf(row).reserved);

/**
 * Reserve funds for a payout (section 11): the amount leaves the available
 * balance straight away and sits on `pending_balance`, so the same money can
 * never be withdrawn twice while the request is pending.
 */
async function reserve(opts) {
  const {
    userId, type = 'WITHDRAWAL', amount, description = '', reference = null,
    provider = null, providerRef = null, idempotencyKey = null, metadata = {},
  } = opts || {};
  validate({ type, amount });

  const user = await users.byId(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });

  const existing = await byIdempotencyKey(idempotencyKey);
  if (existing) return { transaction: existing, balance: r2(user.balance), duplicate: true };

  if (r2(user.balance) < r2(amount)) {
    throw Object.assign(new Error('Insufficient withdrawable balance'), { status: 400 });
  }

  const row = await ledger.create({
    txn_id: newTxnId(),
    user_id: Number(user.id),
    type, status: 'PENDING',
    amount: r2(amount),
    currency_code: String(user.currency_code || config.wallet.currency).toUpperCase(),
    description: String(description).slice(0, 200),
    reference, provider, provider_ref: providerRef,
    idempotency_key: idempotencyKey,
    metadata: JSON.stringify({ ...metadata, reserved: true }),
  });

  await users.adjust(user.id, 'balance', -r2(amount));
  const updated = await users.adjust(user.id, 'pending_balance', r2(amount));
  const saved = await ledger.update(row.id, {
    balance_after: r2(updated.balance),
    updated_at: new Date().toISOString(),
  });
  return { transaction: saved, balance: r2(updated.balance), duplicate: false };
}

/** Release a reservation back to the available balance (payout failed/cancelled). */
async function releaseReservation(txnOrId, { reason = 'Payout not completed', status = 'FAILED' } = {}) {
  const row = typeof txnOrId === 'object' ? txnOrId : await ledger.byId(txnOrId);
  if (!row) throw new Error('Transaction not found');
  if (['COMPLETED', 'FAILED', 'REVERSED'].includes(row.status)) return { transaction: row, duplicate: true };
  if (!isReserved(row)) throw new Error('Transaction is not a reservation');

  await users.adjust(row.user_id, 'pending_balance', -r2(row.amount));
  const updated = await users.adjust(row.user_id, 'balance', r2(row.amount));
  const saved = await ledger.update(row.id, {
    status,
    reference: reason,
    balance_after: r2(updated.balance),
    updated_at: new Date().toISOString(),
  });
  return { transaction: saved, balance: r2(updated.balance), duplicate: false };
}

/** Complete a reservation: the held funds are gone for good (payout settled). */
async function settleReservation(txnOrId, { reference = null, providerRef = null, metadata = null } = {}) {
  const row = typeof txnOrId === 'object' ? txnOrId : await ledger.byId(txnOrId);
  if (!row) throw new Error('Transaction not found');
  if (['COMPLETED', 'FAILED', 'REVERSED'].includes(row.status)) return { transaction: row, duplicate: true };
  if (!isReserved(row)) throw new Error('Transaction is not a reservation');

  await users.adjust(row.user_id, 'pending_balance', -r2(row.amount));
  await users.adjust(row.user_id, 'total_withdrawn', r2(row.amount));
  const user = await users.byId(row.user_id);
  const patch = {
    status: 'COMPLETED',
    balance_after: r2(user ? user.balance : 0),
    updated_at: new Date().toISOString(),
  };
  if (reference) patch.reference = reference;
  if (providerRef) patch.provider_ref = providerRef;
  if (metadata) patch.metadata = JSON.stringify({ ...metadataOf(row), ...metadata });
  const saved = await ledger.update(row.id, patch);
  return { transaction: saved, duplicate: false };
}

/**
 * Settle a PENDING entry to COMPLETED (money actually moves now) or FAILED.
 * Terminal rows are never touched again, so callbacks cannot double-credit.
 */
async function settle(txnOrId, status, { reference = null, providerRef = null, metadata = null } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`Unknown status ${status}`);
  const row = typeof txnOrId === 'object' ? txnOrId : await ledger.byId(txnOrId);
  if (!row) throw new Error('Transaction not found');
  if (['COMPLETED', 'FAILED', 'REVERSED'].includes(row.status)) {
    return { transaction: row, duplicate: true };
  }
  // Reserved debits are settled with settleReservation() so the held amount is
  // never debited from the available balance twice.
  if (isReserved(row)) {
    return status === 'COMPLETED'
      ? settleReservation(row, { reference, providerRef, metadata })
      : releaseReservation(row, { reason: 'Payment not confirmed' });
  }

  const user = await users.byId(row.user_id);
  if (!user) throw new Error('Transaction user missing');

  const patch = { status, updated_at: new Date().toISOString() };
  if (reference) patch.reference = reference;
  if (providerRef) patch.provider_ref = providerRef;
  if (metadata) patch.metadata = JSON.stringify(metadata);

  if (status === 'COMPLETED') {
    const updated = await applyBalance(user, row.type, row.amount);
    patch.balance_after = r2(updated.balance);
  }

  const saved = await ledger.update(row.id, patch);
  return { transaction: saved, duplicate: false };
}

/**
 * Reverse a COMPLETED entry. Writes a compensating REVERSAL row and moves the
 * original to REVERSED — the original row itself is never mutated away.
 */
async function reverse(txnId, { reason = 'Reversal', idempotencyKey = null } = {}) {
  const row = await ledger.byId(txnId);
  if (!row) throw Object.assign(new Error('Transaction not found'), { status: 404 });
  if (row.status === 'REVERSED') return { transaction: row, duplicate: true };
  if (row.status !== 'COMPLETED') throw Object.assign(new Error('Only completed transactions can be reversed'), { status: 400 });

  const user = await users.byId(row.user_id);
  if (!user) throw new Error('Transaction user missing');

  const originalDelta = isCredit(row.type) ? row.amount : -row.amount;
  // Reverse the original direction.
  const fields = { balance: -r2(originalDelta) };
  if (row.type === 'DEPOSIT') fields.total_deposited = -r2(row.amount);
  if (row.type === 'WITHDRAWAL') fields.total_withdrawn = -r2(row.amount);
  if (['WATCH_REWARD', 'REFERRAL_REWARD'].includes(row.type)) fields.total_earned = -r2(row.amount);
  let updated = user;
  for (const [field, value] of Object.entries(fields)) {
    updated = (await users.adjust(user.id, field, value)) || updated;
  }

  const compensateDelta = -r2(originalDelta);
  const reversal = await ledger.create({
    txn_id: newTxnId(),
    user_id: Number(user.id),
    type: 'REVERSAL',
    status: 'COMPLETED',
    amount: r2(row.amount),
    currency_code: row.currency_code,
    description: `${reason} — reversal of ${row.txn_id}`,
    reference: row.txn_id,
    provider: row.provider,
    idempotency_key: idempotencyKey || `reversal:${row.txn_id}`,
    balance_after: r2(updated.balance),
    metadata: JSON.stringify({ direction: compensateDelta > 0 ? 'credit' : 'debit', original_type: row.type }),
  });

  const reversed = await ledger.update(row.id, { status: 'REVERSED', updated_at: new Date().toISOString() });
  return { transaction: reversed, reversal, duplicate: false };
}

/** Latest ledger entries for a user (newest first). */
async function history(userId, { filter = 'all', limit = 20, offset = 0 } = {}) {
  const typeMap = {
    deposits: ['DEPOSIT'],
    earnings: ['WATCH_REWARD', 'REFERRAL_REWARD'],
    withdrawals: ['WITHDRAWAL', 'FEE'],
  };
  const rows = await ledger.all({ where: { user_id: Number(userId) }, orderBy: 'created_at DESC', limit: 500 });
  const allowed = typeMap[filter];
  const filtered = allowed ? rows.filter((r) => allowed.includes(r.type)) : rows;
  return { rows: filtered.slice(offset, offset + limit), total: filtered.length };
}

/** Ledger-derived wallet totals. Never reads a client-supplied number. */
async function totals(userId) {
  const rows = await ledger.all({ where: { user_id: Number(userId) }, limit: 2000 });
  const sum = (types, statuses = ['COMPLETED']) => r2(rows
    .filter((r) => types.includes(r.type) && statuses.includes(r.status))
    .reduce((s, r) => s + Number(r.amount || 0), 0));

  const user = await users.byId(userId);
  const pendingWithdrawals = r2(rows
    .filter((r) => r.type === 'WITHDRAWAL' && ['PENDING', 'COMPLETED'].includes(r.status))
    .reduce((s, r) => s + Number(r.amount || 0), 0));

  return {
    currency_code: user ? user.currency_code : config.wallet.currency,
    available: user ? r2(user.balance) : 0,
    pending: user ? r2(user.pending_balance) : 0,
    reserved: pendingWithdrawals,
    total_earned: sum(['WATCH_REWARD', 'REFERRAL_REWARD']),
    total_deposited: sum(['DEPOSIT']),
    total_withdrawn: sum(['WITHDRAWAL']),
    total_fees: sum(['FEE']),
    total_reversed: sum(['REVERSAL']),
  };
}

/** Immutable audit record for admin actions. */
async function audit({ actorId = null, actorRole = null, action, targetType = null, targetId = null, detail = null }) {
  try {
    await new Table('audit_logs').create({
      actor_id: actorId ? Number(actorId) : null,
      actor_role: actorRole,
      action: String(action).slice(0, 80),
      target_type: targetType,
      target_id: targetId != null ? String(targetId) : null,
      detail: detail ? String(detail).slice(0, 1000) : null,
    });
  } catch (e) {
    console.warn('[audit] failed to write entry:', e.message);
  }
}

/** Consistency check used by tests/admin: recompute balance from the ledger. */
async function reconcile(userId) {
  const user = await users.byId(userId);
  if (!user) return null;
  const rows = await ledger.all({ where: { user_id: Number(userId) }, limit: 5000 });
  const expected = r2(rows
    .filter((r) => r.status === 'COMPLETED')
    .reduce((sum, r) => sum + (isCredit(r.type) ? Number(r.amount || 0) : -Number(r.amount || 0)), 0));
  return { user_id: Number(userId), balance: r2(user.balance), ledger_balance: expected, matches: expected === r2(user.balance) };
}

module.exports = {
  TYPES, STATUSES, DIRECTION, isCredit, isReserved, metadataOf, newTxnId,
  record, credit, debit, reserve, releaseReservation, settleReservation,
  settle, reverse, history, totals, audit, reconcile,
  get store() { return getDb(); },
};
