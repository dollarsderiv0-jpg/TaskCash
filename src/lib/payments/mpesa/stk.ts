import { logger } from "@/lib/logger";
import { pickString, providerSaysOk, providerErrorMessage } from "@/lib/payments/parse";
import { darajaRequest, MpesaError } from "@/lib/payments/mpesa/client";
import { getAccessToken } from "@/lib/payments/mpesa/auth";
import { collectionConfig } from "@/lib/payments/mpesa/config";
import type { ProviderResult } from "@/lib/payments/types";
import type { StkPushResponse, StkQueryResponse } from "@/lib/payments/mpesa/types";

/**
 * M-Pesa Express — the deposit path (STK Push).
 *
 * We only ever *initiate* here. Safaricom's acknowledgement means "the customer
 * has been prompted", nothing more: the customer still has to enter their PIN,
 * and they can cancel. Nothing is credited until either the callback or an STK
 * status query independently confirms the payment (see verify.ts).
 */

/** Daraja's `AccountReference` is limited to 12 characters. */
export const ACCOUNT_REFERENCE_MAX = 12;
/** Daraja's `TransactionDesc` is limited to 13 characters. */
export const TRANSACTION_DESC_MAX = 13;

export type InitiateStkPushInput = {
  /** Our own reference. Also what we show the customer where it fits. */
  merchantReference: string;
  /** Customer MSISDN in 2547XXXXXXXX form. */
  phone: string;
  amount: number;
  description: string;
  callbackUrl?: string;
  /** Defaults to the configured TransactionType. */
  transactionType?: "CustomerPayBillOnline" | "CustomerBuyGoodsOnline";
};

/**
 * Daraja timestamps are in the provider's local time (EAT), not UTC.
 *
 * Sending a UTC timestamp is a classic silent failure: the request is accepted
 * or rejected depending on how far the clock is off, and the error message
 * points at the password rather than the time. Formatting with an explicit
 * time zone removes the ambiguity.
 */
export function darajaTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";

  // en-GB with hour12:false can render midnight as "24"; Daraja wants 00.
  const hour = get("hour") === "24" ? "00" : get("hour");

  return `${get("year")}${get("month")}${get("day")}${hour}${get("minute")}${get("second")}`;
}

/** base64(ShortCode + Passkey + Timestamp) — per the M-Pesa Express docs. */
export function stkPassword(shortCode: string, passKey: string, timestamp: string): string {
  return Buffer.from(`${shortCode}${passKey}${timestamp}`).toString("base64");
}

/**
 * Daraja wants a 12-digit MSISDN with no plus sign (`2547XXXXXXXX`), while the
 * rest of the application stores E.164 (`+2547XXXXXXXX`). Converting here — at
 * the provider boundary, once — keeps one representation everywhere else, and
 * an unparseable number is refused rather than sent as a prompt for a stranger.
 */
export function toDarajaMsisdn(phone: string): string {
  const digits = (phone ?? "").replace(/[^\d]/g, "");

  // 0712345678 → 254712345678
  const national = digits.length === 10 && digits.startsWith("0") ? `254${digits.slice(1)}` : null;
  // 712345678 → 254712345678
  const bare = digits.length === 9 && /^[17]/.test(digits) ? `254${digits}` : null;
  const candidate = digits.startsWith("254") && digits.length === 12 ? digits : (national ?? bare);

  if (!candidate) {
    throw new MpesaError(
      "INVALID_PHONE",
      "M-Pesa needs a Safaricom number in the form 2547XXXXXXXX.",
    );
  }
  return candidate;
}

/**
 * M-Pesa Express only accepts whole shillings. Rather than rounding — which
 * would make the requested amount differ from the recorded one, and so break
 * the amount check that protects settlement — we refuse and say so.
 */
export function assertWholeShillings(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new MpesaError("AMOUNT_INVALID", "The amount must be greater than zero.");
  }
  if (!Number.isInteger(amount)) {
    throw new MpesaError(
      "AMOUNT_NOT_WHOLE",
      "M-Pesa accepts whole shillings only. Please round the amount to the nearest shilling.",
    );
  }
}

export async function initiateStkPush(input: InitiateStkPushInput): Promise<ProviderResult> {
  const config = collectionConfig();
  assertWholeShillings(input.amount);
  const msisdn = toDarajaMsisdn(input.phone);

  const token = await getAccessToken();
  const timestamp = darajaTimestamp();

  const payload = await darajaRequest<StkPushResponse>("/mpesa/stkpush/v1/processrequest", {
    method: "POST",
    operation: "c2b.stkpush",
    accessToken: token,
    // A retried STK Push sends the customer a second prompt, so this is
    // single-attempt by construction. 5xx is handled by leaving the deposit
    // PENDING for reconciliation, never by firing again.
    retryable: false,
    requestReference: input.merchantReference,
    body: {
      BusinessShortCode: config.shortCode,
      Password: stkPassword(config.shortCode, config.passKey, timestamp),
      Timestamp: timestamp,
      TransactionType: input.transactionType ?? config.transactionType,
      Amount: input.amount,
      PartyA: msisdn,
      PartyB: config.shortCode,
      PhoneNumber: msisdn,
      CallBackURL: input.callbackUrl ?? config.callbackUrl,
      AccountReference: input.merchantReference.slice(0, ACCOUNT_REFERENCE_MAX),
      TransactionDesc: input.description.slice(0, TRANSACTION_DESC_MAX),
    },
  });

  const raw = payload as unknown as Record<string, unknown>;
  const checkoutRequestId = pickString(raw, ["CheckoutRequestID"]);
  const merchantRequestId = pickString(raw, ["MerchantRequestID"]);
  const accepted = providerSaysOk(raw) && Boolean(checkoutRequestId);

  logger.info("mpesa_stk_push_initiated", {
    environment: collectionConfig().shortCode ? "configured" : "unconfigured",
    accepted,
    // The customer's number and the amount are payment metadata, not secrets,
    // but the reference alone is enough to correlate a support call.
    requestReference: input.merchantReference,
  });

  return {
    ok: accepted,
    // Accepted means the prompt was SENT. The customer still has to pay.
    outcome: accepted ? "PENDING" : "FAILED",
    checkoutRequestId,
    merchantRequestId,
    providerTransactionId: null,
    amount: input.amount,
    resultCode: pickString(raw, ["ResponseCode"]),
    safeMessage:
      pickString(raw, ["CustomerMessage", "ResponseDescription"]) ??
      (accepted
        ? "Payment request sent to the customer."
        : providerErrorMessage(raw) ?? "The payment request was rejected."),
    raw,
  };
}

/**
 * Asks Safaricom what actually happened to an STK Push.
 *
 * This is the synchronous check available for collections, and the customer
 * having cancelled is a normal outcome (ResultCode 1032), not an error.
 */
export async function queryStkStatus(checkoutRequestId: string): Promise<ProviderResult> {
  const config = collectionConfig();
  const token = await getAccessToken();
  const timestamp = darajaTimestamp();

  const payload = await darajaRequest<StkQueryResponse>("/mpesa/stkpushquery/v1/query", {
    method: "POST",
    operation: "c2b.stkquery",
    accessToken: token,
    // A status query changes nothing, so it is safe to retry.
    retryable: true,
    requestReference: checkoutRequestId,
    body: {
      BusinessShortCode: config.shortCode,
      Password: stkPassword(config.shortCode, config.passKey, timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    },
  });

  const raw = payload as unknown as Record<string, unknown>;
  const resultCode = pickString(raw, ["ResultCode", "ResponseCode"]);
  const resultDesc = pickString(raw, ["ResultDesc", "ResponseDescription"]);

  return {
    ok: resultCode === "0",
    outcome: outcomeFromStkResultCode(resultCode, resultDesc),
    checkoutRequestId,
    merchantRequestId: pickString(raw, ["MerchantRequestID"]),
    // The query does not return the receipt; the callback carries that.
    providerTransactionId: null,
    // Nor does it return the amount — which is exactly why a settled deposit
    // must still have its amount checked against the callback metadata.
    amount: null,
    resultCode,
    safeMessage: resultDesc ?? "Transaction status retrieved.",
    raw,
  };
}

/**
 * Daraja result codes. The vocabulary is documented by Safaricom and is
 * distinct from "the HTTP call failed": these are outcomes of a payment the
 * customer was asked to authorise.
 */
export function outcomeFromStkResultCode(
  code: string | null,
  fallbackText?: string | null,
): ProviderResult["outcome"] {
  const normalized = (code ?? "").trim();

  if (normalized === "0") return "SUCCESS";
  // 1032 cancelled by user, 1037 DS timeout / unreachable, 1019 expired.
  if (normalized === "1032" || normalized === "1037" || normalized === "1019") return "CANCELLED";
  // 1 insufficient balance, 2001 invalid initiator, 1025 push error,
  // 1001 subscriber locked, 9999 general error, 11 invalid state.
  if (normalized !== "") return "FAILED";

  const text = (fallbackText ?? "").toLowerCase();
  if (!text) return "UNKNOWN";
  if (/success|processed successfully/.test(text)) return "SUCCESS";
  if (/cancel|timeout|timed out|expired/.test(text)) return "CANCELLED";
  if (/fail|insufficient|declin|invalid|error|reject/.test(text)) return "FAILED";
  if (/pending|processing|await/.test(text)) return "PENDING";
  return "UNKNOWN";
}
