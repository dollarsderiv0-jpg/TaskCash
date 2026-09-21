import { payheroRequest, pickNumber, pickString } from "@/lib/payments/payhero/client";
import type { PaymentOutcome, ProviderResult } from "@/lib/payments/payhero/types";
import type { VerificationVerdict } from "@/lib/payments/verify-types";

/**
 * Authoritative verification.
 *
 * A PayHero callback is treated as a *hint*. Before any wallet is credited or
 * any withdrawal is settled, we ask PayHero directly for the transaction
 * status. If PayHero cannot confirm, the local record stays PENDING and a
 * reconciliation alert is raised — never "credited anyway".
 *
 * This is the security boundary. A forged callback, a replayed callback or a
 * callback delivered to the wrong URL can at most cause a status *lookup*.
 */

const SUCCESS_WORDS = new Set(["SUCCESS", "COMPLETED", "PAID", "SUCCESSFUL", "TRUE"]);
const PENDING_WORDS = new Set(["QUEUED", "PENDING", "PROCESSING", "INITIATED", "SENT", "AWAITING"]);
const CANCELLED_WORDS = new Set(["CANCELLED", "CANCELED", "USER_CANCELLED", "REVERSED"]);
const FAILED_WORDS = new Set(["FAILED", "FAIL", "REJECTED", "DECLINED", "ERROR", "TIMEOUT", "INSUFFICIENT_FUNDS"]);

/** Daraja result codes PayHero forwards verbatim. */
const CANCELLED_CODES = new Set(["1032", "1037"]);
const PENDING_CODES = new Set(["1000", "1001", "1"]);

export function outcomeFromPayhero(
  status: string | null,
  resultCode: string | null,
  fallbackText?: string | null,
): PaymentOutcome {
  const word = (status ?? "").trim().toUpperCase();
  if (word && SUCCESS_WORDS.has(word)) return "SUCCESS";
  if (word && PENDING_WORDS.has(word)) return "PENDING";
  if (word && CANCELLED_WORDS.has(word)) return "CANCELLED";
  if (word && FAILED_WORDS.has(word)) return "FAILED";

  const code = (resultCode ?? "").trim().toUpperCase();
  if (code === "0" || code === "00" || code === "000" || code === "200") return "SUCCESS";
  if (CANCELLED_CODES.has(code)) return "CANCELLED";
  if (PENDING_CODES.has(code)) return "PENDING";

  const text = (fallbackText ?? "").toLowerCase();
  if (!text) return "UNKNOWN";
  if (/success|completed|paid|credited/.test(text)) return "SUCCESS";
  if (/cancel/.test(text)) return "CANCELLED";
  if (/pending|processing|queued|await/.test(text)) return "PENDING";
  if (/fail|insufficient|declin|reject|error|timeout/.test(text)) return "FAILED";
  return "UNKNOWN";
}

/**
 * Reads one transaction's status.
 *
 * PayHero nests the underlying provider result under `response`, so both levels
 * are merged before reading — a field may legitimately appear in either.
 */
export async function queryTransactionStatus(reference: string): Promise<ProviderResult> {
  const payload = await payheroRequest<Record<string, unknown>>(
    `/transaction-status?reference=${encodeURIComponent(reference)}`,
    {
      method: "GET",
      operation: "transaction.status",
      retryable: true,
      requestReference: reference,
    },
  );

  const top = payload as Record<string, unknown>;
  const nested =
    top.response && typeof top.response === "object" && !Array.isArray(top.response)
      ? (top.response as Record<string, unknown>)
      : null;

  // Flat reads first, then the nested result, then both again for the fields
  // PayHero spells differently at each level.
  const merged: Record<string, unknown> = { ...(nested ?? {}), ...top };

  const status = pickString(merged, ["status", "Status", "transaction_status", "TransactionStatus"]);
  const resultCode = pickString(merged, ["ResultCode", "ResponseCode", "result_code", "resultCode"]);
  const description = pickString(merged, [
    "ResultDesc",
    "message",
    "detail",
    "response_description",
    "ResponseDescription",
  ]);

  const outcome = outcomeFromPayhero(status, resultCode, description);

  return {
    ok: outcome === "SUCCESS",
    outcome,
    checkoutRequestId: pickString(merged, ["reference", "Reference", "CheckoutRequestID"]),
    merchantRequestId: pickString(merged, ["MerchantRequestID", "MerchantRequestId"]),
    // The M-Pesa receipt number is the identifier a customer will quote.
    providerTransactionId: pickString(merged, [
      "MpesaReceiptNumber",
      "transaction_code",
      "TransactionCode",
      "receipt_number",
      "provider_transaction_id",
    ]),
    amount: pickNumber(merged, ["amount", "Amount", "TransactionAmount", "TransAmount"]),
    resultCode: resultCode ?? status,
    safeMessage: description ?? "Transaction status retrieved.",
    raw: top,
  };
}

function verdict(input: {
  result: ProviderResult;
  expectedAmount: number;
  pendingNote: string;
}): VerificationVerdict {
  const { result, expectedAmount } = input;
  const providerAmount = result.amount;
  const amountMatches =
    providerAmount === null ? true : Math.abs(providerAmount - expectedAmount) < 0.01;

  if (result.outcome === "SUCCESS" && !amountMatches) {
    // A confirmed payment for the wrong amount must never be silently credited.
    return {
      confirmed: false,
      terminal: false,
      outcome: "UNKNOWN",
      providerTransactionId: result.providerTransactionId,
      providerAmount,
      amountMatches: false,
      result,
      note: `Provider amount (${providerAmount}) does not match the expected amount (${expectedAmount}).`,
    };
  }

  return {
    confirmed: result.outcome === "SUCCESS" && amountMatches,
    terminal: result.outcome === "FAILED" || result.outcome === "CANCELLED",
    outcome: result.outcome,
    providerTransactionId: result.providerTransactionId,
    providerAmount,
    amountMatches,
    result,
    note: result.outcome === "SUCCESS" || result.outcome === "FAILED" || result.outcome === "CANCELLED"
      ? result.safeMessage
      : input.pendingNote,
  };
}

/** Confirms a collection before crediting a deposit. */
export async function verifyCollection(input: {
  checkoutRequestId: string | null;
  expectedAmount: number;
}): Promise<VerificationVerdict> {
  const missingRef: VerificationVerdict = {
    confirmed: false,
    terminal: false,
    outcome: "UNKNOWN",
    providerTransactionId: null,
    providerAmount: null,
    amountMatches: false,
    result: null,
    note: "No provider reference available to verify against.",
  };

  if (!input.checkoutRequestId) return missingRef;

  let result: ProviderResult;
  try {
    result = await queryTransactionStatus(input.checkoutRequestId);
  } catch {
    return {
      ...missingRef,
      note: "Provider status check could not be completed. Deposit left pending.",
    };
  }

  return verdict({
    result,
    expectedAmount: input.expectedAmount,
    pendingNote: "PayHero has not yet confirmed this payment. Deposit left pending.",
  });
}

/** Confirms a disbursement before the withdrawal is marked COMPLETED. */
export async function verifyDisbursement(input: {
  checkoutRequestId: string | null;
  expectedAmount: number;
}): Promise<VerificationVerdict> {
  const missingRef: VerificationVerdict = {
    confirmed: false,
    terminal: false,
    outcome: "UNKNOWN",
    providerTransactionId: null,
    providerAmount: null,
    amountMatches: false,
    result: null,
    note: "No provider reference available to verify against.",
  };

  if (!input.checkoutRequestId) return missingRef;

  let result: ProviderResult;
  try {
    result = await queryTransactionStatus(input.checkoutRequestId);
  } catch {
    return {
      ...missingRef,
      note: "Provider status check could not be completed. Withdrawal left in processing.",
    };
  }

  return verdict({
    result,
    expectedAmount: input.expectedAmount,
    pendingNote: "PayHero has not yet confirmed this payout. Withdrawal left in processing.",
  });
}
