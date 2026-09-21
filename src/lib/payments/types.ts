/**
 * Provider-agnostic payment types.
 *
 * These describe what the *application* needs to know about a payment attempt,
 * independent of which provider produced it. SasaPay and M-Pesa (Daraja) both
 * map onto these shapes, which is what lets `@/lib/payments/provider` swap one
 * for the other without the deposit/withdrawal services knowing the difference.
 *
 * Why this lives outside `sasapay/`: the money-movement paths (deposit
 * settlement, withdrawal approval) must not import a provider's module just to
 * name a type, or "use a different provider" would mean editing the financial
 * code. `sasapay/types.ts` re-exports these for backwards compatibility.
 */

/** The normalized outcome vocabulary. Every provider maps onto this. */
export type PaymentOutcome = "SUCCESS" | "PENDING" | "FAILED" | "CANCELLED" | "UNKNOWN";

/** Providers this deployment knows how to talk to. */
export type PaymentProviderId = "MPESA" | "SASAPAY" | "PAYHERO";

/** A callback, normalized. Untrusted input reduced to comparable fields. */
export type NormalizedCallback = {
  direction: "COLLECTION" | "DISBURSEMENT";
  providerTransactionId: string | null;
  merchantReference: string | null;
  checkoutRequestId: string | null;
  amount: number | null;
  currency: string | null;
  phone: string | null;
  outcome: PaymentOutcome;
  resultCode: string | null;
  resultDescription: string | null;
  raw: Record<string, unknown>;
};

/**
 * The result of *initiating* a payment. Note that `ok: true` means only that
 * the provider accepted the request — it is not a payment. Settlement always
 * requires either a verified callback or a status query.
 */
export type ProviderResult = {
  ok: boolean;
  outcome: PaymentOutcome;
  /** The provider's identifiers, kept on the local record for reconciliation. */
  checkoutRequestId: string | null;
  merchantRequestId: string | null;
  providerTransactionId: string | null;
  amount: number | null;
  resultCode: string | null;
  /** Safe to show an operator; never shown raw to an end user. */
  safeMessage: string;
  raw: Record<string, unknown>;
};

/**
 * Can a payout actually leave the building?
 *
 * `SIMULATOR_ONLY` is deliberately treated as NOT payable: a simulated payout
 * would record a completed payment that never happened, and a fake payout
 * record is indistinguishable from a real one once it is in the ledger.
 */
export type PayoutMode = "LIVE" | "SIMULATOR_ONLY" | "NOT_CONFIGURED";

export type PayoutReadiness = {
  mode: PayoutMode;
  canExecute: boolean;
  /** Shown to the administrator verbatim. Never implies a payment was made. */
  message: string;
  /** Variable NAMES that are unset — never their values. */
  missing: string[];
  /** Which provider the payout would go through. */
  provider: PaymentProviderId | null;
};
