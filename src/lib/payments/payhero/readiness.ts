import { hasPayheroPayoutCredentials, missingPayheroPayoutEnv } from "@/lib/env";
import type { PayoutReadiness } from "@/lib/payments/types";

/**
 * Can a payout actually leave the building?
 *
 * One decision point, asked before any disbursement is attempted, because the
 * failure mode this guards against is subtle: with no credentials, an approval
 * that blindly calls the provider ends up releasing the hold and marking the
 * withdrawal FAILED — the administrator's decision silently undone, and the
 * real cause ("we have no PayHero account") reported as "the provider did not
 * accept the payout". Those are different facts and only one of them is true.
 *
 * There is no simulator branch here, deliberately. PayHero has no sandbox host
 * and this integration contains no code that fabricates a provider response, so
 * `SIMULATOR_ONLY` is not reachable for this provider — and a payout that was
 * never sent must never be recordable as one that was.
 */
export function payoutReadiness(): PayoutReadiness {
  if (!hasPayheroPayoutCredentials()) {
    return {
      mode: "NOT_CONFIGURED",
      canExecute: false,
      message:
        "PayHero is not configured. This withdrawal is approved and the funds remain held — no " +
        "payment was sent. Add the PayHero API credentials, then send the payout.",
      missing: missingPayheroPayoutEnv(),
      provider: "PAYHERO",
    };
  }

  return {
    mode: "LIVE",
    canExecute: true,
    message: "",
    missing: [],
    provider: "PAYHERO",
  };
}
