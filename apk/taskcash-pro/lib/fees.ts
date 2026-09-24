/**
 * Withdrawal pricing.
 *
 * Kept in one place because a fee is the easiest thing in a wallet to get
 * inconsistent: the form previews it, the confirmation repeats it, the ledger
 * records it and the history renders it. All four read this module.
 *
 * The prototype charges a percentage of the amount requested — the fee is taken
 * out of the request, so the user receives the remainder. Requesting 1,000 means
 * a 100 fee and 900 received, and 1,000 leaves the available balance.
 */

/** Charged on every withdrawal. */
export const WITHDRAWAL_FEE_RATE = 0.1;

export const WITHDRAWAL_FEE_PCT = WITHDRAWAL_FEE_RATE * 100;

const round2 = (value: number) => Math.round(value * 100) / 100;

export interface WithdrawalQuote {
  /** What the user asked for. This is what leaves their available balance. */
  gross: number;
  /** The platform's cut, deducted from the gross. */
  fee: number;
  /** What actually reaches the user's mobile money. */
  net: number;
  /** Gross as a share of the wallet, for copy like "10% fee". */
  feeRate: number;
}

/**
 * Quotes a withdrawal. Returns a zeroed quote for anything that is not a
 * positive, finite number, so callers never have to guard against NaN reaching
 * the UI.
 */
export function quoteWithdrawal(gross: number): WithdrawalQuote {
  if (!Number.isFinite(gross) || gross <= 0) {
    return { gross: 0, fee: 0, net: 0, feeRate: WITHDRAWAL_FEE_RATE };
  }
  const fee = round2(gross * WITHDRAWAL_FEE_RATE);
  return { gross: round2(gross), fee, net: round2(gross - fee), feeRate: WITHDRAWAL_FEE_RATE };
}

/** Reconstructs the fee for an amount when only the gross is stored. */
export const feeOn = (gross: number) => quoteWithdrawal(gross).fee;

/**
 * The fee charged on a stored withdrawal.
 *
 * Prefers what was recorded at the time and falls back to the current rate for
 * rows written before the fee existed — a ledger restored from an older
 * localStorage payload, for instance. Every fee read in the UI goes through
 * here, so a row and the total above it can never disagree.
 */
export const feeForTransaction = (gross: number, recorded?: number) =>
  recorded ?? feeOn(gross);

/** The net payout for a stored withdrawal, derived the same way. */
export const netForTransaction = (gross: number, fee: number, recorded?: number) =>
  recorded ?? round2(gross - fee);
