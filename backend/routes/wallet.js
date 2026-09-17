/**
 * Wallet routes (sections 08 – 13, 27, 28).
 *
 * Rules enforced here:
 *   - balances are read from the server-side ledger, never from the client;
 *   - a deposit is Pending until a verified provider result says otherwise —
 *     pressing Continue never produces a "Successful" screen;
 *   - a withdrawal reserves the amount immediately (no double withdrawal) and
 *     stays Pending until the provider confirms the payout;
 *   - every operation writes an immutable ledger entry with an idempotency key.
 */
const express = require('express');
const { Table } = require('../db');
const config = require('../config');
const { wrap, r2, txnRef, toMpesaFormat, isValidKenyanPhone } = require('../lib/helpers');
const { formatMoney } = require('../lib/money');
const { requireAuth } = require('../middleware/auth');
const ledger = require('../services/ledger');
const payments = require('../services/payments');
const settings = require('../services/settings');
const notify = require('../services/notify');
const ws = require('../lib/ws');

const router = express.Router();
const users = new Table('users');
const deposits = new Table('deposits');
const withdrawals = new Table('withdrawals');

const STATUS_LABEL = {
  pending: 'Pending',
  successful: 'Successful',
  failed: 'Failed',
  processing: 'Processing',
  completed: 'Completed',
  PENDING: 'Pending',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  REVERSED: 'Reversed',
};

const label = (s) => STATUS_LABEL[s] || s;

// ── Wallet summary (section 08) ──────────────────────────────
router.get('/summary', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const totals = await ledger.totals(user.id);
  res.json({
    ...totals,
    currency_code: totals.currency_code || config.wallet.currency,
    wallet_balance_source: 'server-ledger',
  });
}));

// ── Configurable limits shown on the deposit / withdraw screens ──
router.get('/config', requireAuth, wrap(async (_req, res) => {
  const s = await settings.publicConfig();
  res.json({
    currency_code: s.currency_code,
    min_deposit: s.min_deposit,
    max_deposit: s.max_deposit,
    min_withdrawal: s.min_withdrawal,
    withdrawal_fee_pct: s.withdrawal_fee_pct,
    expected_processing: s.expected_processing,
    payment_provider: s.payment_provider,
  });
}));

// ── Transaction history (sections 08, 13) ────────────────────
router.get('/transactions', requireAuth, wrap(async (req, res) => {
  const filter = ['all', 'deposits', 'earnings', 'withdrawals'].includes(String(req.query.filter))
    ? String(req.query.filter) : 'all';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const { rows, total } = await ledger.history(req.user.id, { filter, limit, offset });
  res.json({
    filter,
    total,
    limit,
    offset,
    has_more: offset + rows.length < total,
    transactions: rows.map((r) => ({
      txn_id: r.txn_id,
      type: r.type,
      status: r.status,
      status_label: label(r.status),
      direction: ledger.isCredit(r.type) ? 'in' : 'out',
      amount: r2(r.amount),
      currency_code: r.currency_code,
      description: r.description,
      reference: r.reference,
      created_at: r.created_at,
      balance_after: r.balance_after != null ? r2(r.balance_after) : null,
    })),
  });
}));

// ── Deposits (section 09) ────────────────────────────────────
router.post('/deposit', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

  const s = await settings.publicConfig();
  const amount = r2(req.body.amount);
  const phone = toMpesaFormat(req.body.phone || user.phone);

  if (!(amount > 0)) return res.status(400).json({ error: 'Enter a valid deposit amount' });
  if (amount < Number(s.min_deposit)) return res.status(400).json({ error: `Minimum deposit is ${formatMoney(s.min_deposit, s.currency_code, 0)}` });
  if (amount > Number(s.max_deposit)) return res.status(400).json({ error: `Maximum deposit is ${formatMoney(s.max_deposit, s.currency_code, 0)}` });
  if (!isValidKenyanPhone(phone)) return res.status(400).json({ error: 'Enter a valid M-Pesa number (07XXXXXXXX)' });

  // Duplicate-submit protection: the same form submission can never open two
  // pending deposits (and therefore can never send two STK pushes).
  const clientKey = req.body.idempotency_key ? String(req.body.idempotency_key).slice(0, 120) : null;
  if (clientKey) {
    const existing = await deposits.get({ idempotency_key: clientKey });
    if (existing) {
      return res.status(200).json({ ok: true, duplicate: true, deposit: shapeDeposit(existing) });
    }
  }

  const deposit = await deposits.create({
    txn_id: txnRef('WR-'),
    user_id: Number(user.id),
    amount,
    currency_code: s.currency_code,
    payment_method: 'mpesa',
    phone,
    status: 'pending',
    idempotency_key: clientKey || `deposit:${user.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
  });

  try {
    const started = await payments.startDeposit({ user, deposit, phone, amount });
    await ledger.audit({
      action: 'deposit.created',
      targetType: 'deposit',
      targetId: deposit.txn_id,
      detail: `amount=${amount} provider=${started.provider} sandbox=${started.sandbox}`,
    });
    res.status(202).json({
      ok: true,
      deposit: shapeDeposit(started.deposit),
      status_label: label('pending'),
      sandbox: started.sandbox,
      message: started.message,
    });
  } catch (e) {
    await deposits.update(deposit.id, {
      status: 'failed',
      failure_reason: String(e.message).slice(0, 300),
      updated_at: new Date().toISOString(),
    });
    await ledger.record({
      userId: user.id,
      type: 'DEPOSIT',
      amount,
      status: 'FAILED',
      description: 'Deposit could not be initiated',
      reference: deposit.txn_id,
      idempotencyKey: `deposit-failed:${deposit.txn_id}`,
      metadata: { reason: String(e.message).slice(0, 200) },
    });
    res.status(e.status || 502).json({ error: e.message });
  }
}));

// Deposit status (section 10). `?verify=1` asks the provider for the
// authoritative state instead of only reading our own row.
router.get('/deposits/:id', requireAuth, wrap(async (req, res) => {
  const deposit = await findDeposit(req.params.id, req.user.id);
  if (!deposit) return res.status(404).json({ error: 'Deposit not found' });

  let current = deposit;
  let detail = null;
  let providerPending = false;
  if (String(req.query.verify) === '1' && deposit.status === 'pending') {
    try {
      const out = await payments.refreshDeposit(deposit);
      current = out.deposit;
      detail = out.detail;
      providerPending = Boolean(out.pending);
      if (out.status === 'successful') {
        await notify.push(req.user.id, { title: 'Deposit Successful', message: `${formatMoney(current.amount)} has been added to your wallet.`, type: 'success', link: '#/wallet' });
      }
    } catch (e) {
      detail = e.message;
      providerPending = true;
    }
  }

  res.json({
    deposit: shapeDeposit(current),
    provider_pending: providerPending,
    detail,
    // Never label a payment as successful unless the provider confirmed it.
    is_successful: current.status === 'successful',
    is_failed: current.status === 'failed',
  });
}));

// ── Withdrawals (sections 11, 12) ────────────────────────────
router.post('/withdraw/quote', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  const s = await settings.publicConfig();
  const amount = r2(req.body.amount);
  const fee = r2((amount || 0) * (Number(s.withdrawal_fee_pct) / 100));
  const net = r2(Math.max(0, (amount || 0) - fee));
  const available = r2(user ? user.balance : 0);

  const errors = [];
  if (!(amount > 0)) errors.push('Enter a withdrawal amount');
  if (amount > 0 && amount < Number(s.min_withdrawal)) errors.push(`Minimum withdrawal is ${formatMoney(s.min_withdrawal, s.currency_code, 0)}`);
  if (amount > available) errors.push('Amount exceeds your available balance');

  res.json({
    amount,
    fee,
    net_amount: net,
    fee_pct: r2(s.withdrawal_fee_pct),
    currency_code: s.currency_code,
    min_withdrawal: r2(s.min_withdrawal),
    expected_processing: s.expected_processing,
    available,
    valid: errors.length === 0,
    errors,
    message: 'You will receive the amount shown after the processing fee is deducted.',
  });
}));

router.post('/withdraw', requireAuth, wrap(async (req, res) => {
  const user = await users.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

  const s = await settings.publicConfig();
  const amount = r2(req.body.amount);
  const phone = toMpesaFormat(req.body.phone || user.payout_phone || user.phone);

  if (!(amount > 0)) return res.status(400).json({ error: 'Enter a valid withdrawal amount' });
  if (amount < Number(s.min_withdrawal)) {
    return res.status(400).json({ error: `Minimum withdrawal is ${formatMoney(s.min_withdrawal, s.currency_code, 0)}` });
  }
  if (!isValidKenyanPhone(phone)) return res.status(400).json({ error: 'Enter a valid M-Pesa phone number (07XXXXXXXX)' });
  if (r2(user.balance) < amount) return res.status(400).json({ error: 'Insufficient balance for this withdrawal' });

  const clientKey = req.body.idempotency_key ? String(req.body.idempotency_key).slice(0, 120) : null;
  if (clientKey) {
    const existing = await withdrawals.get({ idempotency_key: clientKey });
    if (existing) return res.status(200).json({ ok: true, duplicate: true, withdrawal: shapeWithdrawal(existing) });
  }

  const fee = r2(amount * (Number(s.withdrawal_fee_pct) / 100));
  const net = r2(amount - fee);
  const requestId = txnRef('WRW-');

  // The request row is written first, then the amount is reserved: the funds
  // leave the available balance immediately, so the same money can never be
  // requested twice while the payout is pending.
  const withdrawal = await withdrawals.create({
    request_id: requestId,
    user_id: Number(user.id),
    amount,
    fee,
    net_amount: net,
    currency_code: s.currency_code,
    method: 'mpesa',
    destination: phone,
    status: 'pending',
    idempotency_key: clientKey || `withdrawal-request:${requestId}`,
  });

  let reservation;
  try {
    reservation = await ledger.reserve({
      userId: user.id,
      type: 'WITHDRAWAL',
      amount,
      description: `Withdrawal to ${maskPhone(phone)}`,
      reference: requestId,
      idempotencyKey: `withdrawal:${requestId}`,
      metadata: { request_id: requestId, fee, net, destination: phone },
    });
  } catch (e) {
    await withdrawals.update(withdrawal.id, {
      status: 'failed',
      failure_reason: String(e.message).slice(0, 300),
      updated_at: new Date().toISOString(),
    });
    return res.status(e.status || 400).json({ error: e.message });
  }

  let providerMessage = null;
  let sandbox = false;
  try {
    const started = await payments.startWithdrawal({ user, withdrawal, phone, amount: net });
    providerMessage = started.message;
    sandbox = started.sandbox;
  } catch (e) {
    // The provider refused the payout: release the reservation immediately.
    await payments.applyWithdrawalResult(withdrawal, { result: 'FAILED', detail: e.message });
    await ledger.audit({
      actorId: user.id,
      actorRole: 'user',
      action: 'withdrawal.provider_rejected',
      targetType: 'withdrawal',
      targetId: requestId,
      detail: String(e.message).slice(0, 300),
    });
    return res.status(e.status || 502).json({ error: e.message });
  }

  await ledger.audit({
    actorId: user.id,
    actorRole: 'user',
    action: 'withdrawal.requested',
    targetType: 'withdrawal',
    targetId: requestId,
    detail: `amount=${amount} fee=${fee} net=${net}`,
  });
  await notify.push(user.id, {
    title: 'Withdrawal Pending',
    message: `Request ${requestId} for ${formatMoney(net)} is being processed. Status stays Pending until M-Pesa confirms the payout.`,
    type: 'info',
    link: '#/transactions',
  });
  ws.broadcastAdmins({ type: 'admin_alert', payload: { kind: 'withdrawal', id: withdrawal.id, request_id: requestId, amount } });

  const fresh = await withdrawals.byId(withdrawal.id);
  res.status(202).json({
    ok: true,
    withdrawal: shapeWithdrawal(fresh || withdrawal),
    reserved_from: reservation.transaction.txn_id,
    balance: reservation.balance,
    sandbox,
    message: providerMessage || 'Withdrawal request submitted. Status will stay Pending until the payout is verified.',
  });
}));

router.get('/withdrawals', requireAuth, wrap(async (req, res) => {
  const rows = await withdrawals.all({ where: { user_id: Number(req.user.id) }, orderBy: 'created_at DESC', limit: 50 });
  res.json({ withdrawals: rows.map(shapeWithdrawal) });
}));

router.get('/withdrawals/:id', requireAuth, wrap(async (req, res) => {
  const withdrawal = await findWithdrawal(req.params.id, req.user.id);
  if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
  res.json({ withdrawal: shapeWithdrawal(withdrawal) });
}));

// ── Helpers ─────────────────────────────────────────────────
function maskPhone(phone) {
  const d = String(phone || '');
  if (d.length < 6) return '07******XX';
  return `${d.slice(0, 2)}******${d.slice(-2)}`;
}

function shapeDeposit(d) {
  return {
    id: d.id,
    txn_id: d.txn_id,
    amount: r2(d.amount),
    currency_code: d.currency_code || config.wallet.currency,
    phone: maskPhone(d.phone),
    status: d.status,
    status_label: label(d.status),
    // Only a verified provider reference is ever exposed.
    payment_reference: d.payment_reference || null,
    provider_ref: d.payment_reference ? d.provider_ref || null : null,
    failure_reason: d.status === 'failed' ? d.failure_reason || null : null,
    verified: Boolean(d.verified_at),
    created_at: d.created_at,
    updated_at: d.updated_at || d.created_at,
  };
}

function shapeWithdrawal(w) {
  return {
    id: w.id,
    request_id: w.request_id,
    amount: r2(w.amount),
    fee: r2(w.fee),
    net_amount: r2(w.net_amount),
    currency_code: w.currency_code || config.wallet.currency,
    destination: maskPhone(w.destination),
    method: w.method,
    status: w.status,
    status_label: label(w.status),
    receipt: w.receipt || null,
    failure_reason: w.status === 'failed' ? w.failure_reason || null : null,
    verified: Boolean(w.verified_at),
    created_at: w.created_at,
    updated_at: w.updated_at || w.created_at,
  };
}

async function findDeposit(idOrTxn, userId) {
  const numeric = Number(idOrTxn);
  const row = Number.isFinite(numeric) && String(numeric) === String(idOrTxn)
    ? await deposits.byId(numeric)
    : await deposits.get({ txn_id: String(idOrTxn) });
  if (!row || Number(row.user_id) !== Number(userId)) return null;
  return row;
}

async function findWithdrawal(idOrRequest, userId) {
  const numeric = Number(idOrRequest);
  const row = Number.isFinite(numeric) && String(numeric) === String(idOrRequest)
    ? await withdrawals.byId(numeric)
    : await withdrawals.get({ request_id: String(idOrRequest) });
  if (!row || Number(row.user_id) !== Number(userId)) return null;
  return row;
}

module.exports = router;
module.exports.shapeDeposit = shapeDeposit;
module.exports.shapeWithdrawal = shapeWithdrawal;
module.exports.maskPhone = maskPhone;
module.exports.label = label;
