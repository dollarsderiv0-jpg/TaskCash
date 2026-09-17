/**
 * Payment provider interface.
 *
 * Every provider implements the same five operations so route code never knows
 * which one is active:
 *
 *   createDeposit({ user, deposit, phone, amount })  -> { providerRef, status, message, sandbox }
 *   verifyDeposit({ deposit })                       -> { status: 'PENDING'|'SUCCESSFUL'|'FAILED', reference, detail }
 *   createWithdrawal({ user, withdrawal, phone, amount }) -> { providerRef, status, message, sandbox }
 *   verifyWithdrawal({ withdrawal })                 -> { status: 'PENDING'|'PROCESSING'|'COMPLETED'|'FAILED', reference, detail }
 *   handleCallback(body)                             -> { kind, providerRef, result, reference, amount, phone, raw }
 *
 * Contract for all implementations:
 *   - `status: 'SUCCESSFUL'` may only be returned from a verified provider
 *     result (a real callback or a live status query). Nothing in this layer
 *     may invent a receipt number.
 *   - Credentials are read from server-side environment variables only. No key,
 *     secret or passkey is ever sent to the browser.
 *   - Providers that can only simulate (sandbox) must refuse to run when
 *     NODE_ENV=production and must mark everything they return as `sandbox`.
 */

class PaymentError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'PaymentError';
    this.status = status;
  }
}

/** Thrown when the platform is asked to take money with no live provider. */
class PaymentNotConfiguredError extends PaymentError {
  constructor(message = 'Payments are not configured on this server') {
    super(message, 503);
    this.name = 'PaymentNotConfiguredError';
  }
}

/** Re-exported for the provider modules. */
module.exports = { PaymentError, PaymentNotConfiguredError };
