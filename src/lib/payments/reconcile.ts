import type { PaymentOutcome } from "@/lib/payments/types";

/**
 * Deciding what to do about one provider-side payment.
 *
 * Pure on purpose: every branch here is a money decision, and a money decision
 * that can only be exercised by making a real payment is a money decision nobody
 * tests. `sweepProviderPayments` supplies the facts from the database and acts
 * on the verdict; this file only decides.
 *
 * The direction matters. Every other reconciliation path starts from a local
 * record. This one starts from the provider, so it is the only thing in the
 * product that can notice a payment that was taken and never credited — or taken
 * and never recorded at all.
 */

/** What the provider says about one of its transactions. */
export type ProviderPaymentFacts = {
  reference: string | null;
  externalReference: string | null;
  amount: number | null;
  outcome: PaymentOutcome;
  receipt: string | null;
  phone: string | null;
  occurredAt: string | null;
};

/** What we hold locally for the matching deposit, or null when we hold nothing. */
export type LocalDepositFacts = {
  id: string;
  merchantReference: string;
  amount: number;
  currency: string;
  status: string;
} | null;

export type ReconcileAlertType =
  | "PROVIDER_COMPLETED_MISSING_LOCAL"
  | "PAYMENT_NOT_CREDITED"
  | "AMOUNT_MISMATCH";

export type ReconcileDecision =
  | { action: "SKIP"; reason: string }
  | { action: "SETTLE"; reason: string }
  | {
      action: "ALERT";
      alertType: ReconcileAlertType;
      severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
      reason: string;
      entityType: "deposit" | "provider_transaction";
      entityId: string | null;
      reference: string;
      /** Everything an operator needs to settle it by hand. */
      details: Record<string, unknown>;
    };

/**
 * Statuses that mean we already gave the money to the customer and closed the
 * record — a provider payment landing on one of these is a genuine conflict.
 */
const LOCALLY_CLOSED = ["FAILED", "CANCELLED", "REJECTED", "REVERSED"];

/** Statuses where the local record is still waiting for the provider. */
const LOCALLY_OPEN = ["PENDING", "PROCESSING"];

const AMOUNT_TOLERANCE = 0.01;

function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) < AMOUNT_TOLERANCE;
}

export function classifyProviderPayment(
  payment: ProviderPaymentFacts,
  deposit: LocalDepositFacts,
): ReconcileDecision {
  const reference = payment.externalReference ?? payment.reference ?? "(no reference)";

  // Only a payment the provider reports as *paid* is actionable. Everything else
  // is either already handled by the local sweep (pending, failed) or not money.
  if (payment.outcome !== "SUCCESS") {
    return {
      action: "SKIP",
      reason: `Provider reports this as ${payment.outcome}, which is not a completed payment.`,
    };
  }

  /*
    THE case this sweep exists for: PayHero took the money and we have no deposit
    at all. Either the row was never written, or a human deleted it. We cannot
    credit a wallet automatically because there is nobody to credit — the customer
    must be identified first. This is reported for manual settlement, and it is
    severity CRITICAL because real money has already moved.
  */
  if (!deposit) {
    return {
      action: "ALERT",
      alertType: "PROVIDER_COMPLETED_MISSING_LOCAL",
      severity: "CRITICAL",
      reason:
        "The provider reports this payment as paid, and no deposit exists for it locally. " +
        "Money has been taken; it must be settled by hand.",
      entityType: "provider_transaction",
      entityId: null,
      reference,
      details: {
        providerReference: payment.reference,
        externalReference: payment.externalReference,
        amount: payment.amount,
        receipt: payment.receipt,
        phone: payment.phone,
        occurredAt: payment.occurredAt,
        note:
          "Identify the customer (phone number or external reference), then settle with an audited " +
          "admin wallet adjustment — POST /api/admin/adjustments — and mark this alert resolved.",
      },
    };
  }

  /*
    A confirmed payment for the wrong amount is its own problem: crediting it
    would hand over an amount the customer did not pay; refusing it silently
    would keep money that arrived. Neither is ours to decide, so it is reported.
  */
  if (payment.amount !== null && !sameAmount(payment.amount, deposit.amount)) {
    return {
      action: "ALERT",
      alertType: "AMOUNT_MISMATCH",
      severity: "HIGH",
      reason:
        `The provider reports ${payment.amount} but the deposit was created for ${deposit.amount}. ` +
        "Not credited automatically.",
      entityType: "deposit",
      entityId: deposit.id,
      reference,
      details: {
        expected: deposit.amount,
        provider: payment.amount,
        currency: deposit.currency,
        receipt: payment.receipt,
        note: "Confirm the correct amount with the customer before crediting.",
      },
    };
  }

  if (deposit.status === "COMPLETED") {
    return { action: "SKIP", reason: "The deposit is already credited to the wallet." };
  }

  if (LOCALLY_OPEN.includes(deposit.status)) {
    return {
      action: "SETTLE",
      // Settlement is the existing, idempotent, provider-verified path — the same
      // one the callback and the "I have paid" button use. This sweep does not
      // credit anything itself.
      reason:
        "The provider confirms this payment is paid and the deposit is still open; " +
        "settlement will re-verify with the provider and credit it once.",
    };
  }

  if (LOCALLY_CLOSED.includes(deposit.status)) {
    return {
      action: "ALERT",
      alertType: "PAYMENT_NOT_CREDITED",
      severity: "CRITICAL",
      reason:
        `The provider reports this payment as paid, but the deposit is ${deposit.status} locally. ` +
        "The customer paid and was told, in effect, that it failed.",
      entityType: "deposit",
      entityId: deposit.id,
      reference,
      details: {
        depositStatus: deposit.status,
        expected: deposit.amount,
        provider: payment.amount,
        currency: deposit.currency,
        receipt: payment.receipt,
        merchantReference: deposit.merchantReference,
        note:
          "Re-run reconciliation on this deposit first; if the provider confirms the payment, credit " +
          "the wallet with an audited admin adjustment and mark this alert resolved.",
      },
    };
  }

  return {
    action: "SKIP",
    reason: `Deposit status "${deposit.status}" needs no provider-side action.`,
  };
}
