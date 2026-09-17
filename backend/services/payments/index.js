/**
 * Payment abstraction layer (section 28).
 *
 * Route code talks to `payments` only — never to Daraja directly — so the live
 * provider can be swapped without touching the wallet, and sandbox behaviour
 * can never leak into production.
 *
 * Resolution rules:
 *   NODE_ENV=production + live credentials   -> mpesa (live)
 *   NODE_ENV=production, no credentials      -> unconfigured (fails loudly)
 *   development + credentials                -> mpesa (Daraja sandbox)
 *   development, no credentials              -> sandbox (clearly labelled)
 */
const config = require('../../config');
const { Table } = require('../../db');
const { r2 } = require('../../lib/helpers');
const { formatMoney } = require('../../lib/money');
const { PaymentError, PaymentNotConfiguredError } = require('./provider');
const mpesaProvider = require('./mpesa-provider');
const sandboxProvider = require('./sandbox-provider');
const ledger = require('../ledger');
const notify = require('../notify');
const ws = require('../../lib/ws');

const deposits = new Table('deposits');
const withdrawals = new Table('withdrawals');

/** Production guard: refuses every operation, so nothing fake can be shown. */
const unconfiguredProvider = {
  id: 'unconfigured',
  label: 'No payment provider configured',
  live: false,
  mode: 'unconfigured',
  canPayout: () => false,
  async createDeposit() {
    throw new PaymentNotConfiguredError('Live M-Pesa credentials are not configured on this server — deposits are unavailable');
  },
  async verifyDeposit() { return { status: 'PENDING', detail: 'No payment provider configured' }; },
  async createWithdrawal() {
    throw new PaymentNotConfiguredError('Live M-Pesa payout credentials are not configured on this server');
  },
  async verifyWithdrawal() { return { status: 'PENDING', detail: 'No payment provider configured' }; },
  handleCallback() { throw new PaymentNotConfiguredError('No payment provider configured'); },
  callbackKey: (kind, providerRef) => `unconfigured:${kind}:${providerRef}`,
};

function resolveProvider() {
  if (config.isProd) return mpesaProvider.live ? mpesaProvider : unconfiguredProvider;
  if (config.mpesa.enabled) return mpesaProvider;
  return sandboxProvider;
}

let cached = null;
function getProvider() {
  if (!cached || cached.id !== resolveProvider().id) cached = resolveProvider();
  return cached;
}

/** Safe, public description of the active provider (no credentials). */
function describe() {
  const p = getProvider();
  return {
    id: p.id,
    label: p.label,
    mode: p.mode,
    live: Boolean(p.live),
    sandbox: p.id === 'sandbox',
    payouts_enabled: Boolean(p.canPayout ? p.canPayout() : false),
    simulated: p.id === 'sandbox',
  };
}

const providerName = () => getProvider().id;

// ── Deposits ────────────────────────────────────────────────
/**
 * Apply a provider result to a deposit and the ledger.
 * `result` is one of SUCCESS | FAILED | PENDING.
 * Idempotent: a settled deposit is never settled again.
 */
async function applyDepositResult(deposit, { result, reference = null, detail = null, sandbox = false } = {}) {
  if (!deposit) throw new PaymentError('Deposit not found', 404);
  if (deposit.status === 'successful' || deposit.status === 'failed') {
    return { deposit, idempotent: true };
  }
  if (result === 'PENDING' || !result) return { deposit, pending: true };

  const provider = providerName();
  const now = new Date().toISOString();

  if (result === 'SUCCESS') {
    if (!reference && !sandbox) {
      // A live success must carry a provider receipt — never invent one.
      throw new PaymentError('Provider did not return a payment reference', 502);
    }
    const updated = await deposits.update(deposit.id, {
      status: 'successful',
      payment_reference: reference || 'SANDBOX',
      provider,
      verified_at: now,
      updated_at: now,
      failure_reason: null,
    });

    const { transaction } = await ledger.record({
      userId: deposit.user_id,
      type: 'DEPOSIT',
      amount: r2(deposit.amount),
      status: 'COMPLETED',
      description: sandbox ? 'Sandbox deposit (not a real M-Pesa payment)' : 'M-Pesa deposit',
      reference: reference || deposit.txn_id,
      provider,
      providerRef: deposit.provider_ref,
      idempotencyKey: `deposit:${deposit.txn_id}`,
      metadata: { txn_id: deposit.txn_id, sandbox },
    });

    await notify.push(deposit.user_id, {
      title: sandbox ? 'Sandbox deposit confirmed' : 'Deposit Successful',
      message: sandbox
        ? `${formatMoney(deposit.amount)} was added to your wallet in sandbox mode. No real M-Pesa payment was made.`
        : `${formatMoney(deposit.amount)} has been added to your wallet. Reference ${reference}.`,
      type: 'success',
      link: '#/wallet',
    });
    ws.broadcastAdmins({ type: 'admin_alert', payload: { kind: 'deposit', id: deposit.id, amount: deposit.amount, sandbox } });
    return { deposit: updated, transaction, status: 'successful' };
  }

  // Failure is recorded in the ledger too — every attempt leaves a trace.
  const updated = await deposits.update(deposit.id, {
    status: 'failed',
    failure_reason: String(detail || 'Payment could not be confirmed').slice(0, 300),
    provider,
    verified_at: now,
    updated_at: now,
  });
  await ledger.record({
    userId: deposit.user_id,
    type: 'DEPOSIT',
    amount: r2(deposit.amount),
    status: 'FAILED',
    description: 'Deposit failed',
    reference: deposit.txn_id,
    provider,
    providerRef: deposit.provider_ref,
    idempotencyKey: `deposit-failed:${deposit.txn_id}`,
    metadata: { txn_id: deposit.txn_id, detail: detail || null },
  });
  await notify.push(deposit.user_id, {
    title: 'Deposit Failed',
    message: detail ? String(detail).slice(0, 180) : 'The payment could not be confirmed. No money has left your M-Pesa account.',
    type: 'danger',
    link: '#/deposit',
  });
  return { deposit: updated, status: 'failed' };
}

/** Ask the provider to start a deposit and store its reference. */
async function startDeposit({ user, deposit, phone, amount }) {
  const provider = getProvider();
  const out = await provider.createDeposit({ user, deposit, phone, amount });
  const updated = await deposits.update(deposit.id, {
    provider: provider.id,
    provider_ref: out.providerRef || null,
    updated_at: new Date().toISOString(),
  });
  return { deposit: updated, provider: provider.id, sandbox: Boolean(out.sandbox), message: out.message };
}

/**
 * Ask the provider for the authoritative status of a deposit.
 * The row is always re-read afterwards, so a status change that arrived by
 * callback while we were checking is reflected in the response.
 */
async function refreshDeposit(deposit) {
  const provider = getProvider();
  const out = await provider.verifyDeposit({ deposit });
  if (out.status === 'PENDING') {
    const fresh = await deposits.byId(deposit.id);
    return { deposit: fresh || deposit, status: (fresh || deposit).status, detail: out.detail || null, pending: true };
  }
  const applied = await applyDepositResult(deposit, {
    result: out.status === 'SUCCESSFUL' ? 'SUCCESS' : out.status === 'FAILED' ? 'FAILED' : 'PENDING',
    reference: out.reference || null,
    detail: out.detail || null,
    sandbox: provider.id === 'sandbox',
  });
  return { ...applied, detail: out.detail || null };
}

// ── Withdrawals ─────────────────────────────────────────────
/**
 * Apply a provider result to a withdrawal and settle its reservation.
 * `result` is one of SUCCESS | FAILED | PROCESSING | PENDING.
 */
async function applyWithdrawalResult(withdrawal, { result, reference = null, detail = null, providerRef = null } = {}) {
  if (!withdrawal) throw new PaymentError('Withdrawal not found', 404);
  if (withdrawal.status === 'completed' || withdrawal.status === 'failed') {
    return { withdrawal, idempotent: true };
  }

  const txn = await new Table('wallet_transactions').get({ idempotency_key: `withdrawal:${withdrawal.request_id}` });
  const now = new Date().toISOString();

  if (result === 'SUCCESS') {
    const updated = await withdrawals.update(withdrawal.id, {
      status: 'completed',
      receipt: reference || withdrawal.receipt || null,
      provider_ref: providerRef || withdrawal.provider_ref,
      verified_at: now,
      processed_at: now,
      updated_at: now,
      failure_reason: null,
    });
    if (txn) await ledger.settleReservation(txn, { reference: reference || withdrawal.request_id, providerRef: providerRef || withdrawal.provider_ref });
    // Processing fee is booked as its own ledger entry (informational — the
    // gross amount was already debited when the payout succeeded).
    if (Number(withdrawal.fee) > 0) {
      await ledger.record({
        userId: withdrawal.user_id,
        type: 'FEE',
        amount: r2(withdrawal.fee),
        status: 'COMPLETED',
        description: `Withdrawal fee (${withdrawal.request_id})`,
        reference: withdrawal.request_id,
        provider: providerName(),
        idempotencyKey: `withdrawal-fee:${withdrawal.request_id}`,
        informational: true,
      });
    }
    await notify.push(withdrawal.user_id, {
      title: 'Withdrawal completed',
      message: `${formatMoney(withdrawal.net_amount)} was sent to ${withdrawal.destination}. Reference ${reference || withdrawal.request_id}.`,
      type: 'success',
      link: '#/transactions',
    });
    return { withdrawal: updated, status: 'completed' };
  }

  if (result === 'PROCESSING' || result === 'PENDING') {
    const updated = await withdrawals.update(withdrawal.id, {
      status: 'processing',
      provider_ref: providerRef || withdrawal.provider_ref,
      updated_at: now,
    });
    return { withdrawal: updated, status: 'processing', pending: true };
  }

  // Failure: the reserved funds go straight back to the available balance.
  const updated = await withdrawals.update(withdrawal.id, {
    status: 'failed',
    failure_reason: String(detail || 'Payout could not be confirmed').slice(0, 300),
    provider_ref: providerRef || withdrawal.provider_ref,
    verified_at: now,
    updated_at: now,
  });
  if (txn) await ledger.releaseReservation(txn, { reason: String(detail || 'Payout not completed').slice(0, 120) });
  await notify.push(withdrawal.user_id, {
    title: 'Withdrawal not completed',
    message: `${formatMoney(withdrawal.amount)} has been returned to your available balance. ${detail ? String(detail).slice(0, 160) : ''}`.trim(),
    type: 'warning',
    link: '#/wallet',
  });
  if (txn) await ledger.audit({ action: 'withdrawal.failed', targetType: 'withdrawal', targetId: withdrawal.request_id, detail: detail || null });
  return { withdrawal: updated, status: 'failed' };
}

/** Submit a payout request to the provider (status stays pending until verified). */
async function startWithdrawal({ user, withdrawal, phone, amount }) {
  const provider = getProvider();
  const out = await provider.createWithdrawal({ user, withdrawal, phone, amount });
  const updated = await withdrawals.update(withdrawal.id, {
    provider: provider.id,
    provider_ref: out.providerRef || null,
    status: out.status === 'PROCESSING' ? 'processing' : 'pending',
    updated_at: new Date().toISOString(),
  });
  return { withdrawal: updated, provider: provider.id, message: out.message, sandbox: Boolean(out.sandbox) };
}

/** Ask the provider for the authoritative status of a withdrawal. */
async function refreshWithdrawal(withdrawal) {
  const provider = getProvider();
  const current = (await withdrawals.byId(withdrawal.id)) || withdrawal;
  const out = await provider.verifyWithdrawal({ withdrawal: current });
  const applied = await applyWithdrawalResult(current, {
    result: out.status === 'COMPLETED' ? 'SUCCESS' : out.status === 'FAILED' ? 'FAILED' : out.status === 'PROCESSING' ? 'PROCESSING' : 'PENDING',
    reference: out.reference || null,
    detail: out.detail || null,
  });
  const fresh = await withdrawals.byId(withdrawal.id);
  return { ...applied, withdrawal: fresh || applied.withdrawal || current };
}

/** Route a raw provider callback payload to the right reconciliation. */
async function handleCallback(body) {
  const provider = getProvider();
  const parsed = provider.handleCallback(body);

  if (parsed.kind === 'deposit') {
    const deposit = await deposits.get({ provider_ref: parsed.providerRef });
    if (!deposit) return { kind: 'deposit', matched: false, providerRef: parsed.providerRef };
    const out = await applyDepositResult(deposit, {
      result: parsed.result,
      reference: parsed.reference,
      detail: parsed.detail,
      sandbox: Boolean(parsed.sandbox),
    });
    return { kind: 'deposit', matched: true, idempotent: Boolean(out.idempotent), status: out.status || deposit.status };
  }

  const withdrawal = await withdrawals.get({ provider_ref: parsed.providerRef });
  if (!withdrawal) return { kind: 'withdrawal', matched: false, providerRef: parsed.providerRef };
  const out = await applyWithdrawalResult(withdrawal, {
    result: parsed.result,
    reference: parsed.reference,
    detail: parsed.detail,
  });
  return { kind: 'withdrawal', matched: true, idempotent: Boolean(out.idempotent), status: out.status || withdrawal.status };
}

module.exports = {
  getProvider, describe, providerName, resolveProvider,
  startDeposit, refreshDeposit, applyDepositResult,
  startWithdrawal, refreshWithdrawal, applyWithdrawalResult,
  handleCallback,
  PaymentError, PaymentNotConfiguredError,
  providers: { mpesa: mpesaProvider, sandbox: sandboxProvider, unconfigured: unconfiguredProvider },
};
