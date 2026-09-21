import {
  hasMpesaCollectionCredentials,
  hasMpesaPayoutCredentials,
  missingMpesaCollectionEnv,
  missingMpesaPayoutEnv,
} from "@/lib/payments/mpesa/config";
import type { PayoutReadiness } from "@/lib/payments/types";

/**
 * Can a payout actually leave the building?
 *
 * One decision point, asked before any disbursement is attempted, because the
 * failure mode this guards against is subtle: with no credentials, an approval
 * that blindly calls Safaricom ends up releasing the hold and marking the
 * withdrawal FAILED — the administrator's decision silently undone, and the
 * real cause ("we have no B2C account") reported as "Safaricom did not accept
 * the payout". Those are different facts and only one of them is true.
 *
 * There is no simulator on the M-Pesa side at all. A simulated B2C response
 * would record a completed payout that never happened, and a fake payout record
 * is indistinguishable from a real one once it is in the ledger.
 */
export function mpesaPayoutReadiness(): PayoutReadiness {
  if (!hasMpesaPayoutCredentials()) {
    const missing = [
      ...(hasMpesaCollectionCredentials() ? [] : missingMpesaCollectionEnv()),
      ...missingMpesaPayoutEnv(),
    ];

    return {
      mode: "NOT_CONFIGURED",
      canExecute: false,
      provider: "MPESA",
      message:
        "M-Pesa is not configured. This withdrawal is approved and the funds remain held — no " +
        "payment was sent. Add the M-Pesa (Daraja) credentials, then send the payout.",
      missing,
    };
  }

  return { mode: "LIVE", canExecute: true, message: "", missing: [], provider: "MPESA" };
}
