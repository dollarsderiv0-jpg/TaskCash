import { getServerEnv } from "@/lib/env";
import { pickNumber, pickString, sasapayRequest } from "@/lib/payments/sasapay/client";
import { getAccessToken } from "@/lib/payments/sasapay/auth";
import type {
  PaymentOutcome,
  ProviderResult,
  TransactionStatusResponse,
} from "@/lib/payments/sasapay/types";

/**
 * Authoritative verification.
 *
 * A SasaPay callback is treated as a *hint*. Before any wallet is credited or
 * any withdrawal is settled, we ask the provider directly for the transaction
 * status. If the provider cannot confirm, the local record stays PENDING and a
 * reconciliation alert is raised — never "credited anyway".
 */

const SUCCESS_CODES = new Set(["0", "00", "000", "200", "SUCCESS", "COMPLETED", "TRUE"]);
const CANCELLED_CODES = new Set(["1032", "1037", "CANCELLED", "CANCELED", "USER_CANCELLED"]);
const FAILED_CODES = new Set([
  "1",
  "2",
  "2001",
  "2002",
  "4001",
  "FAILED",
  "FAIL",
  "INSUFFICIENT_FUNDS",
  "DECLINED",
]);

export function outcomeFromCode(code: string | null, fallbackText?: string | null): PaymentOutcome {
  const normalized = (code ?? "").trim().toUpperCase();
  if (normalized && SUCCESS_CODES.has(normalized)) return "SUCCESS";
  if (normalized && CANCELLED_CODES.has(normalized)) return "CANCELLED";
  if (normalized && FAILED_CODES.has(normalized)) return "FAILED";

  const text = (fallbackText ?? "").toLowerCase();
  if (!text) return "UNKNOWN";
  if (/success|completed|paid|credited/.test(text)) return "SUCCESS";
  if (/cancel/.test(text)) return "CANCELLED";
  if (/fail|insufficient|declin|reject|error/.test(text)) return "FAILED";
  if (/pending|processing|await/.test(text)) return "PENDING";
  return "UNKNOWN";
}

export async function queryTransactionStatus(checkoutRequestId: string): Promise<ProviderResult> {
  const env = getServerEnv();
  if (!env.SASAPAY_MERCHANT_CODE) {
    throw new Error("SASAPAY_MERCHANT_CODE is not configured.");
  }

  const token = await getAccessToken();

  const payload = await sasapayRequest<TransactionStatusResponse>("/payments/transaction-status/", {
    method: "POST",
    operation: "transaction.status",
    accessToken: token,
    requestReference: checkoutRequestId,
    retryable: true,
    body: {
      MerchantCode: env.SASAPAY_MERCHANT_CODE,
      CheckoutRequestID: checkoutRequestId,
    },
  });

  const raw = payload as unknown as Record<string, unknown>;
  const resultCode = pickString(raw, ["ResultCode", "ResponseCode", "errorCode"]);
  const statusText = pickString(raw, ["TransactionStatus", "TransactionType", "detail", "message"]);
  const outcome = outcomeFromCode(resultCode, statusText);

  return {
    ok: outcome === "SUCCESS",
    outcome,
    checkoutRequestId,
    merchantRequestId: pickString(raw, ["MerchantRequestID"]),
    providerTransactionId: pickString(raw, ["TransactionCode", "TransID", "TransactionID", "ReceiptNumber"]),
    amount: pickNumber(raw, ["TransactionAmount", "TransAmount", "Amount"]),
    resultCode,
    safeMessage: pickString(raw, ["detail", "message", "ResultDesc"]) ?? "Transaction status retrieved.",
    raw,
  };
}

/**
 * Confirms a collection before crediting a deposit.
 *
 * Returns a strict verdict so the caller can decide between crediting,
 * failing, or leaving the deposit pending for reconciliation.
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

export async function verifyCollection(input: {
  checkoutRequestId: string | null;
  expectedAmount: number;
}): Promise<VerificationVerdict> {
  if (!input.checkoutRequestId) {
    return {
      confirmed: false,
      terminal: false,
      outcome: "UNKNOWN",
      providerTransactionId: null,
      providerAmount: null,
      amountMatches: false,
      result: null,
      note: "No provider checkout reference available to verify against.",
    };
  }

  let result: ProviderResult;
  try {
    result = await queryTransactionStatus(input.checkoutRequestId);
  } catch {
    return {
      confirmed: false,
      terminal: false,
      outcome: "UNKNOWN",
      providerTransactionId: null,
      providerAmount: null,
      amountMatches: false,
      result: null,
      note: "Provider status check could not be completed. Deposit left pending.",
    };
  }

  const providerAmount = result.amount;
  const amountMatches =
    providerAmount === null ? true : Math.abs(providerAmount - input.expectedAmount) < 0.01;

  if (result.outcome === "SUCCESS" && !amountMatches) {
    // A verified payment for the wrong amount must never be silently credited.
    return {
      confirmed: false,
      terminal: false,
      outcome: "UNKNOWN",
      providerTransactionId: result.providerTransactionId,
      providerAmount,
      amountMatches: false,
      result,
      note: `Provider amount (${providerAmount}) does not match the expected amount (${input.expectedAmount}).`,
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
    note: result.safeMessage,
  };
}

/** Confirms a disbursement before the withdrawal is marked COMPLETED. */
export async function verifyDisbursement(input: {
  checkoutRequestId: string | null;
  expectedAmount: number;
}): Promise<VerificationVerdict> {
  if (!input.checkoutRequestId) {
    return {
      confirmed: false,
      terminal: false,
      outcome: "UNKNOWN",
      providerTransactionId: null,
      providerAmount: null,
      amountMatches: false,
      result: null,
      note: "No provider checkout reference available to verify against.",
    };
  }

  let result: ProviderResult;
  try {
    result = await queryTransactionStatus(input.checkoutRequestId);
  } catch {
    return {
      confirmed: false,
      terminal: false,
      outcome: "UNKNOWN",
      providerTransactionId: null,
      providerAmount: null,
      amountMatches: false,
      result: null,
      note: "Provider status check could not be completed. Withdrawal left in processing.",
    };
  }

  const providerAmount = result.amount;
  const amountMatches =
    providerAmount === null ? true : Math.abs(providerAmount - input.expectedAmount) < 0.01;

  return {
    confirmed: result.outcome === "SUCCESS" && amountMatches,
    terminal: result.outcome === "FAILED" || result.outcome === "CANCELLED",
    outcome: result.outcome,
    providerTransactionId: result.providerTransactionId,
    providerAmount,
    amountMatches,
    result,
    note: result.safeMessage,
  };
}
