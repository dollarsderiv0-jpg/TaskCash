/**
 * Payment provider callbacks (section 28).
 *
 * This router is mounted before the CSRF guard because callbacks are
 * server-to-server. Safety comes from three things instead:
 *   1. a callback is matched to a stored provider reference — unknown payloads
 *      change nothing;
 *   2. reconciliation is idempotent (deposit/withdrawal rows are terminal after
 *      settling, and ledger entries carry unique idempotency keys);
 *   3. the sandbox simulator refuses to run in production.
 */
const express = require('express');
const config = require('../config');
const { wrap, r2 } = require('../lib/helpers');
const { Table } = require('../db');
const { requireAuth } = require('../middleware/auth');
const payments = require('../services/payments');

const router = express.Router();
const deposits = new Table('deposits');

/** Daraja STK results (collections) and B2C results (payouts) land here. */
router.post('/callback', wrap(async (req, res) => {
  try {
    const result = await payments.handleCallback(req.body);
    console.log('[payments] callback processed:', JSON.stringify(result));
  } catch (e) {
    // Log and acknowledge: providers retry aggressively on non-200s and each
    // retry is replay-safe anyway.
    console.warn('[payments] callback error:', e.message);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}));

const sandboxEnabled = () =>
  !config.isProd && payments.describe().id === 'sandbox';

/**
 * Development-only simulator so the deposit/withdrawal states can be exercised
 * locally without live credentials. Every record it touches is stamped with a
 * `SANDBOX-` reference, and it is disabled in production (as is the sandbox
 * provider itself).
 */
router.post('/sandbox/callback', requireAuth, wrap(async (req, res) => {
  if (!sandboxEnabled()) {
    return res.status(403).json({ error: 'Sandbox simulation is disabled' });
  }
  const provider = payments.getProvider();
  if (typeof provider.simulate !== 'function') {
    return res.status(403).json({ error: 'Active provider cannot be simulated' });
  }

  const kind = req.body.kind === 'withdrawal' ? 'withdrawal' : 'deposit';
  const result = req.body.result === 'FAILED' ? 'FAILED' : 'SUCCESS';
  const txnId = req.body.txn_id ? String(req.body.txn_id) : null;      // deposit reference (WR-…)
  const requestId = req.body.request_id ? String(req.body.request_id) : null; // withdrawal reference (WRW-…)
  const providerRef = req.body.provider_ref ? String(req.body.provider_ref) : null;

  if (!txnId && !requestId && !providerRef) {
    return res.status(400).json({ error: 'txn_id, request_id or provider_ref is required' });
  }

  // Ownership check: a user may only simulate their own pending record.
  if (kind === 'deposit') {
    const deposit = (txnId && await deposits.get({ txn_id: txnId }))
      || (providerRef && await deposits.get({ provider_ref: providerRef }));
    if (!deposit || Number(deposit.user_id) !== Number(req.user.id)) {
      return res.status(404).json({ error: 'Pending deposit not found' });
    }
    if (deposit.status !== 'pending') return res.json({ ok: true, idempotent: true, status: deposit.status });
    const parsed = provider.simulate({ kind, providerRef: deposit.provider_ref || deposit.txn_id, result });
    const out = await payments.applyDepositResult(deposit, {
      result: parsed.result,
      reference: parsed.reference,
      detail: parsed.detail,
      sandbox: true,
    });
    return res.json({
      ok: true, sandbox: true, txn_id: deposit.txn_id,
      status: out.status || deposit.status, reference: parsed.reference,
    });
  }

  const withdrawals = new Table('withdrawals');
  const withdrawal = (requestId && await withdrawals.get({ request_id: requestId }))
    || (providerRef && await withdrawals.get({ provider_ref: providerRef }));
  if (!withdrawal || Number(withdrawal.user_id) !== Number(req.user.id)) {
    return res.status(404).json({ error: 'Pending withdrawal not found' });
  }
  const parsed = provider.simulate({ kind, providerRef: withdrawal.provider_ref || withdrawal.request_id, result });
  const out = await payments.applyWithdrawalResult(withdrawal, {
    result: parsed.result === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
    reference: parsed.reference,
    detail: parsed.detail,
  });
  res.json({
    ok: true, sandbox: true, request_id: withdrawal.request_id,
    status: out.status || withdrawal.status, amount: r2(withdrawal.amount),
  });
}));

/** Which provider is live (used by the mobile UI footer + admin console). */
router.get('/provider', wrap(async (_req, res) => {
  res.json(payments.describe());
}));

module.exports = router;
