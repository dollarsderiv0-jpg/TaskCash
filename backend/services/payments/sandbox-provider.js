/**
 * Sandbox provider — development only.
 *
 * This provider exists so the whole deposit / withdrawal UX can be built and
 * tested without live M-Pesa credentials. It is deliberately incapable of
 * pretending a payment succeeded:
 *
 *   - createDeposit() only records a local reference; it never returns SUCCESS;
 *   - verifyDeposit()/verifyWithdrawal() always answer PENDING;
 *   - simulate() is the only path that can move money, it stamps every record
 *     with `sandbox: true` and a `SANDBOX-` reference, and it throws the moment
 *     NODE_ENV=production (also enforced at the route level).
 *
 * The UI surfaces this state as "Sandbox — no real M-Pesa payment was made".
 */
const crypto = require('crypto');
const config = require('../../config');
const { toMpesaFormat } = require('../../lib/helpers');
const { PaymentError } = require('./provider');

function sandboxGuard() {
  if (config.isProd) {
    throw new PaymentError('Sandbox payments are disabled in production — configure live M-Pesa credentials', 403);
  }
}

const localRef = (prefix, seed) =>
  `${prefix}${crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 10).toUpperCase()}`;

async function createDeposit({ deposit, phone, amount }) {
  sandboxGuard();
  if (!(Number(amount) > 0)) throw new PaymentError('Invalid deposit amount', 400);
  return {
    providerRef: localRef('SBXD-', `${deposit.txn_id}:${Date.now()}`),
    status: 'PENDING',
    sandbox: true,
    message: 'Sandbox mode: no real M-Pesa request was sent. This deposit stays Pending until it is confirmed.',
  };
}

async function verifyDeposit() {
  sandboxGuard();
  return { status: 'PENDING', detail: 'Sandbox mode — there is no live provider result to verify against' };
}

async function createWithdrawal({ withdrawal, phone }) {
  sandboxGuard();
  return {
    providerRef: localRef('SBXW-', `${withdrawal.request_id}:${Date.now()}`),
    status: 'PENDING',
    sandbox: true,
    message: 'Sandbox mode: the payout was not submitted to M-Pesa. Status stays Pending.',
  };
}

async function verifyWithdrawal() {
  sandboxGuard();
  return { status: 'PENDING', detail: 'Sandbox mode — there is no live provider result to verify against' };
}

function handleCallback() {
  sandboxGuard();
  throw new PaymentError('Sandbox mode has no provider callbacks — use the sandbox simulator', 400);
}

/**
 * Developer-only simulator. Used by POST /api/mpesa/sandbox/callback.
 * Every simulated record is labelled so nothing can be mistaken for a real
 * M-Pesa receipt.
 */
function simulate({ kind, providerRef, result = 'SUCCESS' }) {
  sandboxGuard();
  if (!providerRef) throw new PaymentError('providerRef is required', 400);
  const stamp = `SANDBOX-${kind.toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  return {
    kind,
    providerRef,
    result: result === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
    reference: stamp,
    amount: null,
    phone: null,
    detail: `Simulated by sandbox provider (reference ${stamp}) — not a real M-Pesa transaction`,
    sandbox: true,
    raw: { simulated: true },
  };
}

module.exports = {
  id: 'sandbox',
  label: 'M-Pesa (sandbox / test mode)',
  live: false,
  mode: 'sandbox',
  canPayout: false,
  sandboxGuard,
  createDeposit, verifyDeposit, createWithdrawal, verifyWithdrawal, handleCallback, simulate,
  callbackKey: (kind, providerRef) => `sandbox:${kind}:${providerRef}`,
  normalizePhone: toMpesaFormat,
};
