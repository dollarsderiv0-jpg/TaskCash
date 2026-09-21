import { hasPaymentCredentials, isPaymentSimulatorEnabled, missingPaymentEnv } from "@/lib/env";

/**
 * Can a payout actually leave the building?
 *
 * One decision point, asked before any disbursement is attempted, because the
 * failure mode this guards against is subtle: with no credentials, an approval
 * that blindly calls the provider ends up releasing the hold and marking the
 * withdrawal FAILED — the administrator's decision silently undone, and the
 * real cause ("we have no merchant account") reported as "the provider did not
 * accept the payout". Those are different facts and only one of them is true.
 *
 * SIMULATOR_ONLY is deliberately treated as NOT payable. A simulated B2C
 * response would record a completed payout that never happened, and a fake
 * payout record is indistinguishable from a real one once it is in the ledger.
 * Simulation stays available for collections; the money-out direction does not
 * get to pretend.
 */
export type PayoutMode = "LIVE" | "SIMULATOR_ONLY" | "NOT_CONFIGURED";

export type PayoutReadiness = {
  mode: PayoutMode;
  canExecute: boolean;
  /** Shown to the administrator verbatim. Never implies a payment was made. */
  message: string;
  /** Variable NAMES that are unset — never their values. */
  missing: string[];
};

export function payoutReadiness(): PayoutReadiness {
  if (isPaymentSimulatorEnabled()) {
    return {
      mode: "SIMULATOR_ONLY",
      canExecute: false,
      message:
        "SasaPay is not configured. The local payment simulator is switched on, and a simulated " +
        "payout is not a payment, so this withdrawal has been approved and its funds stay held. " +
        "No payout record was created.",
      missing: missingPaymentEnv(),
    };
  }

  if (!hasPaymentCredentials()) {
    return {
      mode: "NOT_CONFIGURED",
      canExecute: false,
      message:
        "SasaPay is not configured. This withdrawal is approved and the funds remain held — no " +
        "payment was sent. Add the SasaPay merchant credentials, then send the payout.",
      missing: missingPaymentEnv(),
    };
  }

  return { mode: "LIVE", canExecute: true, message: "", missing: [] };
}
