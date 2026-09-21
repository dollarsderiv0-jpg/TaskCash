import type { PaymentOutcome, ProviderResult } from "@/lib/payments/types";

/**
 * The verdict every provider's verification must produce.
 *
 * `confirmed` is the only value that may move money. `terminal` means the
 * provider has said the attempt failed or was cancelled, and the local record
 * should be closed. Anything else means "not established yet" — leave the
 * record pending and let reconciliation or an operator resolve it.
 *
 * Shared so the deposit and withdrawal services can settle a payment without
 * knowing which provider produced the evidence. `sasapay/verify.ts` re-exports
 * this type for backwards compatibility.
 */
export type VerificationVerdict = {
  confirmed: boolean;
  /** True when the provider explicitly says the payment failed or was cancelled. */
  terminal: boolean;
  outcome: PaymentOutcome;
  providerTransactionId: string | null;
  providerAmount: number | null;
  amountMatches: boolean;
  result: ProviderResult | null;
  note: string;
};
