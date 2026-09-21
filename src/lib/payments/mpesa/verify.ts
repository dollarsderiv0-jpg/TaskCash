import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { pickNumber } from "@/lib/payments/parse";
import { queryStkStatus } from "@/lib/payments/mpesa/stk";
import { resultParameterMap, stkCallbackMetadata } from "@/lib/payments/mpesa/callback";
import type { PaymentOutcome, ProviderResult } from "@/lib/payments/types";
import type { VerificationVerdict } from "@/lib/payments/verify-types";

/**
 * Authoritative verification for M-Pesa.
 *
 * Daraja differs from SasaPay in one way that shapes this whole module: a
 * **collection can be queried synchronously** (and must be, because the query
 * does not return the amount), while a **disbursement cannot** — the B2C result
 * arrives asynchronously on ResultURL and there is no synchronous status call.
 *
 * So:
 *
 *   collections  → ask Safaricom (STK query) for the outcome, and take the
 *                  amount from the recorded callback metadata, because the
 *                  query does not carry it. Both must agree before crediting.
 *   disbursements → read the recorded B2C result that arrived on our private
 *                  ResultURL, and only accept it when the callback was
 *                  authenticity-verified and the amount matches. An unverified
 *                  callback is never enough to mark a payout as paid.
 *
 * In both directions the rule is the same: if we cannot establish what the
 * provider actually did, the record stays pending and an operator reconciles.
 * Nothing is ever credited or completed on a guess.
 */

export type { VerificationVerdict };

/**
 * Reads the payment event Safaricom's callback created, if one exists.
 *
 * `payment_events` is written before settlement in the callback route, so it is
 * the record of what the provider told us — including the amount, which the
 * status query omits.
 */
async function recordedEvent(input: {
  direction: "COLLECTION" | "DISBURSEMENT";
  providerTransactionId: string;
}) {
  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("payment_events")
    .select("outcome, signature_valid, payload, created_at")
    .eq("provider", "MPESA")
    .eq("direction", input.direction)
    .eq("provider_transaction_id", input.providerTransactionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{
      outcome: string;
      signature_valid: boolean;
      payload: Record<string, unknown> | null;
      created_at: string;
    }>();

  return data ?? null;
}

function unconfirmed(note: string, extra: Partial<VerificationVerdict> = {}): VerificationVerdict {
  return {
    confirmed: false,
    terminal: false,
    outcome: "UNKNOWN",
    providerTransactionId: null,
    providerAmount: null,
    amountMatches: false,
    result: null,
    note,
    ...extra,
  };
}

/**
 * Confirms a collection before a deposit is credited.
 *
 * Requires BOTH:
 *   - the STK status query to report success, and
 *   - an amount we can compare against the deposit, taken from the recorded
 *     callback metadata.
 *
 * If the query says paid but no amount was ever recorded, we refuse to credit
 * and say why. Crediting an amount we cannot check would mean trusting the
 * local record over the provider, which is the one thing this path exists to
 * prevent.
 */
export async function verifyCollection(input: {
  checkoutRequestId: string | null;
  expectedAmount: number;
}): Promise<VerificationVerdict> {
  if (!input.checkoutRequestId) {
    return unconfirmed("No provider checkout reference available to verify against.");
  }

  let status: ProviderResult;
  try {
    status = await queryStkStatus(input.checkoutRequestId);
  } catch (error) {
    logger.warn("mpesa_stk_query_failed", {
      checkoutRequestId: input.checkoutRequestId,
      error: error instanceof Error ? error.message : "unknown",
    });
    return unconfirmed(
      "Safaricom could not be reached to confirm this payment. The deposit remains pending.",
    );
  }

  if (status.outcome === "FAILED" || status.outcome === "CANCELLED") {
    return {
      confirmed: false,
      terminal: true,
      outcome: status.outcome,
      providerTransactionId: null,
      providerAmount: null,
      amountMatches: false,
      result: status,
      note: status.safeMessage,
    };
  }

  if (status.outcome !== "SUCCESS") {
    return unconfirmed(
      status.safeMessage || "Safaricom has not confirmed this payment yet.",
      { result: status, outcome: status.outcome },
    );
  }

  // The query said paid. The amount has to come from the callback metadata.
  const event = await recordedEvent({
    direction: "COLLECTION",
    providerTransactionId: input.checkoutRequestId,
  });

  const stkCallback = ((event?.payload?.Body ?? {}) as Record<string, unknown>).stkCallback as
    | Record<string, unknown>
    | undefined;
  const flat = stkCallback ? stkCallbackMetadata(stkCallback) : {};

  const providerAmount = pickNumber(flat, ["Amount"]);
  const receipt = flat.MpesaReceiptNumber;

  if (providerAmount === null) {
    return unconfirmed(
      "Safaricom reports the payment as successful but the callback carrying its amount has not " +
        "been received, so the amount cannot be verified. Left pending for reconciliation.",
      { result: status, outcome: "SUCCESS" },
    );
  }

  const amountMatches = Math.abs(providerAmount - input.expectedAmount) < 0.01;
  if (!amountMatches) {
    return {
      confirmed: false,
      terminal: false,
      outcome: "SUCCESS",
      providerTransactionId: typeof receipt === "string" ? receipt : null,
      providerAmount,
      amountMatches: false,
      result: status,
      note: `Provider amount (${providerAmount}) does not match the expected amount (${input.expectedAmount}).`,
    };
  }

  return {
    confirmed: true,
    terminal: false,
    outcome: "SUCCESS",
    providerTransactionId: typeof receipt === "string" && receipt ? receipt : null,
    providerAmount,
    amountMatches: true,
    result: status,
    note: status.safeMessage,
  };
}

/**
 * Confirms a disbursement before a withdrawal is marked COMPLETED.
 *
 * There is no synchronous B2C status call, so the evidence is the B2C result
 * Safaricom POSTed to our ResultURL. It must have been authenticity-verified —
 * an unverified callback is a claim from the internet, and marking a payout
 * paid on one would remove the user's locked funds for a payment that may never
 * have happened.
 */
export async function verifyDisbursement(input: {
  checkoutRequestId: string | null;
  expectedAmount: number;
}): Promise<VerificationVerdict> {
  if (!input.checkoutRequestId) {
    return unconfirmed("No provider conversation reference available to verify against.");
  }

  const event = await recordedEvent({
    direction: "DISBURSEMENT",
    providerTransactionId: input.checkoutRequestId,
  });

  if (!event) {
    return unconfirmed(
      "Safaricom has not yet posted the B2C result for this payout. It stays in processing " +
        "until that result arrives.",
    );
  }

  const result = ((event.payload?.Result ?? {}) as Record<string, unknown>) ?? {};
  const params = resultParameterMap(result);
  const providerAmount = pickNumber(params, ["TransactionAmount"]);
  const receipt = params.TransactionReceipt;

  const outcome: PaymentOutcome =
    event.outcome === "SUCCESS" ? "SUCCESS" : event.outcome === "UNKNOWN" ? "UNKNOWN" : "FAILED";

  if (!event.signature_valid) {
    return unconfirmed(
      "A B2C result for this payout was received but could not be authenticated, so it was not " +
        "acted on. An operator must confirm this payout with Safaricom.",
      { outcome, result: null },
    );
  }

  if (outcome === "SUCCESS") {
    // A successful payout must state an amount; without one we cannot know that
    // what left the account was what the user asked for.
    if (providerAmount === null) {
      return unconfirmed(
        "Safaricom reported this payout as successful without an amount, so the amount could not " +
          "be verified. An operator must confirm it.",
        { outcome: "SUCCESS", result: null },
      );
    }

    const amountMatches = Math.abs(providerAmount - input.expectedAmount) < 0.01;
    if (!amountMatches) {
      return {
        confirmed: false,
        terminal: false,
        outcome: "SUCCESS",
        providerTransactionId: typeof receipt === "string" ? receipt : null,
        providerAmount,
        amountMatches: false,
        result: null,
        note: `Provider amount (${providerAmount}) does not match the expected amount (${input.expectedAmount}).`,
      };
    }

    return {
      confirmed: true,
      terminal: false,
      outcome: "SUCCESS",
      providerTransactionId: typeof receipt === "string" && receipt ? receipt : null,
      providerAmount,
      amountMatches: true,
      result: null,
      note: "Payout confirmed by Safaricom.",
    };
  }

  return {
    confirmed: false,
    terminal: true,
    outcome: outcome === "UNKNOWN" ? "FAILED" : outcome,
    providerTransactionId: null,
    providerAmount,
    amountMatches: true,
    result: null,
    note:
      typeof result.ResultDesc === "string"
        ? result.ResultDesc
        : "Safaricom reported this payout as unsuccessful.",
  };
}
