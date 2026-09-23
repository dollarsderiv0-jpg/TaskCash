import { roundToCents } from "./format";

/**
 * Withdrawal fee calculation.
 *
 * THIS MUST AGREE WITH THE DATABASE. The charge is computed in
 * `public.withdrawal_reserve` (see `supabase/migrations/0026_withdrawal_fee_percent.sql`):
 *
 *     v_fee := coalesce(
 *       p_fee,
 *       case
 *         when v_currency.withdrawal_fee_percent > 0
 *           then round(p_amount * v_currency.withdrawal_fee_percent / 100, 2)
 *         else v_currency.withdrawal_fee
 *       end
 *     );
 *
 * The function below is a mirror of that expression, not an approximation of it.
 * Nothing here decides what a user is charged — the database does, and it
 * re-derives the fee from the amount on insert. This exists so the figure shown
 * before the user confirms is the figure they are charged, and so a mismatch
 * between the two is a test failure rather than a support ticket.
 *
 * A PERCENTAGE WINS OVER THE FLAT FEE. A currency with no percentage configured
 * (`percent` 0) keeps charging its flat `withdrawal_fee`, so this is additive:
 * existing flat-fee behaviour is unchanged.
 */

export type WithdrawalFeeBasis = {
  /** Percentage of the requested amount. Takes precedence when greater than 0. */
  percent: number;
  /** Flat amount charged only when `percent` is 0. */
  flat: number;
};

const safeAmount = (amount: number) => (Number.isFinite(amount) && amount > 0 ? amount : 0);
const safePercent = (percent: number) =>
  Number.isFinite(percent) && percent > 0 ? Math.min(percent, 100) : 0;
const safeFlat = (flat: number) => (Number.isFinite(flat) && flat > 0 ? flat : 0);

/**
 * The fee charged on a request of `amount`.
 *
 * Rounding is to two decimals, matching `round(..., 2)` in the database. That is
 * two decimals for every currency rather than the currency's own minor unit,
 * because that is what the function it mirrors does. The difference only shows
 * up for a zero-decimal currency on an amount not divisible by ten — UGX 1005 at
 * 10% would be 100.5 in both places — and changing it here alone would make the
 * preview disagree with the charge, which is the one outcome worth avoiding.
 */
export function withdrawalFeeFor(amount: number, basis: WithdrawalFeeBasis): number {
  const gross = safeAmount(amount);
  if (gross === 0) return 0;

  const percent = safePercent(basis.percent);
  if (percent > 0) {
    return roundToCents((gross * percent) / 100);
  }

  // The flat fee is a charge against the request, so it can never exceed it: the
  // form caps it at the amount to keep the summary readable, and the database
  // refuses a fee greater than or equal to the request outright.
  return Math.min(safeFlat(basis.flat), gross);
}

/** What actually reaches the user: the request less the fee, never negative. */
export function withdrawalNetFor(amount: number, basis: WithdrawalFeeBasis): number {
  const gross = safeAmount(amount);
  if (gross === 0) return 0;
  return roundToCents(Math.max(0, gross - withdrawalFeeFor(gross, basis)));
}

/** True when a percentage is configured and will be charged. */
export function isPercentageFee(basis: WithdrawalFeeBasis): boolean {
  return safePercent(basis.percent) > 0;
}

/**
 * The label for the fee row: a rate when one is configured, otherwise nothing —
 * a flat fee is a money amount, and the caller formats it with the currency.
 */
export function withdrawalFeeLabel(basis: WithdrawalFeeBasis): string {
  const percent = safePercent(basis.percent);
  return percent > 0 ? `${percent}%` : "Fee";
}
