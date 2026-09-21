import { createHmac } from "crypto";
import { isProduction } from "@/lib/env";
import { logger } from "@/lib/logger";
import { pickNumber, pickString } from "@/lib/payments/sasapay/client";
import { outcomeFromCode } from "@/lib/payments/sasapay/verify";
import type { NormalizedCallback, PaymentOutcome } from "@/lib/payments/sasapay/types";

/**
 * Callback handling.
 *
 * Two things are true at once here:
 *  1. A callback is untrusted input. It is parsed defensively, recorded
 *     verbatim, and never allowed to move money on its own.
 *  2. Because of (1), the *authoritative* confirmation is always the
 *     transaction-status query in verify.ts. Callback signature/IP checks
 *     narrow the attack surface; they are not the security boundary.
 */

export type CallbackAuthenticity = {
  /** True when the request matched a configured verification mechanism. */
  verified: boolean;
  /** True when a configured mechanism rejected the request outright. */
  rejected: boolean;
  reason: string;
};

/** Normalises both the current and the legacy SasaPay callback shapes. */
export function normalizeCallback(
  payload: Record<string, unknown>,
  hint: "COLLECTION" | "DISBURSEMENT" | null = null,
): NormalizedCallback {
  const transactionType = pickString(payload, ["TransactionType", "transaction_type"])?.toUpperCase();
  const direction: "COLLECTION" | "DISBURSEMENT" =
    hint ??
    (transactionType === "B2C" || transactionType === "DISBURSEMENT" ? "DISBURSEMENT" : "COLLECTION");

  const resultCode = pickString(payload, [
    "ResultCode",
    "ResponseCode",
    "resultCode",
    "StatusCode",
  ]);

  const description = pickString(payload, [
    "ResultDesc",
    "ResultDescription",
    "detail",
    "message",
    "errorMessage",
    "ResponseDescription",
  ]);

  const outcome: PaymentOutcome =
    outcomeFromCode(resultCode, description) === "UNKNOWN"
      ? outcomeFromCode(null, description)
      : outcomeFromCode(resultCode, description);

  return {
    direction,
    providerTransactionId: pickString(payload, [
      "TransactionCode",
      "TransID",
      "TransactionID",
      "ReceiptNumber",
      "provider_transaction_id",
      "TransactionReference",
    ]),
    merchantReference: pickString(payload, [
      "AccountReference",
      "account_reference",
      "BillRefNumber",
      "ThirdPartyTransID",
      "InvoiceNumber",
      "merchant_reference",
      "OrderReference",
    ]),
    checkoutRequestId: pickString(payload, [
      "CheckoutRequestID",
      "CheckoutRequestId",
      "checkout_id",
      "MerchantRequestID",
    ]),
    amount: pickNumber(payload, ["TransactionAmount", "TransAmount", "Amount", "amount"]),
    currency: pickString(payload, ["Currency", "currency"]),
    phone: pickString(payload, [
      "MSISDN",
      "PhoneNumber",
      "customer_mobile",
      "ReceiverAccountNumber",
      "MobileNumber",
    ]),
    outcome,
    resultCode,
    resultDescription: description,
    raw: payload,
  };
}

/**
 * Verifies authenticity against whatever the merchant account supports:
 *  - `SASAPAY_CALLBACK_SECRET`: shared secret, either as an HMAC-SHA256 of the
 *    raw body in `x-sasapay-signature`, or as a `token` query parameter.
 *  - `SASAPAY_CALLBACK_IPS`: comma-separated allowlist of provider IPs.
 *
 * If neither is configured the callback is recorded as unverified, which is
 * safe: it still cannot move money without passing the status re-check.
 */
export function checkCallbackAuthenticity(
  request: Request,
  rawBody: string,
): CallbackAuthenticity {
  const secret = process.env.SASAPAY_CALLBACK_SECRET?.trim();
  const allowlist = (process.env.SASAPAY_CALLBACK_IPS ?? "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);

  const url = new URL(request.url);

  if (secret) {
    const signature = request.headers.get("x-sasapay-signature")?.trim();
    const queryToken = url.searchParams.get("token")?.trim();

    if (signature) {
      const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
      const provided = signature.toLowerCase().replace(/^sha256=/, "");
      if (!timingSafeEquals(expected, provided)) {
        return { verified: false, rejected: true, reason: "Signature mismatch." };
      }
      return { verified: true, rejected: false, reason: "Signature verified." };
    }

    if (queryToken) {
      if (!timingSafeEquals(secret, queryToken)) {
        return { verified: false, rejected: true, reason: "Callback token mismatch." };
      }
      return { verified: true, rejected: false, reason: "Callback token verified." };
    }

    return {
      verified: false,
      rejected: true,
      reason: "Callback secret is configured but no signature or token was supplied.",
    };
  }

  if (allowlist.length > 0) {
    const forwarded = request.headers.get("x-forwarded-for");
    const ip = forwarded?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip")?.trim() ?? "";
    if (!ip || !allowlist.includes(ip)) {
      return { verified: false, rejected: true, reason: "Source IP is not in the allowlist." };
    }
    return { verified: true, rejected: false, reason: "Source IP verified." };
  }

  if (isProduction()) {
    logger.warn("callback_unverified_in_production", {
      hint: "Set SASAPAY_CALLBACK_SECRET or SASAPAY_CALLBACK_IPS to narrow callback sources.",
    });
  }

  return {
    verified: false,
    rejected: false,
    reason: "No callback verification mechanism configured; relying on provider status confirmation.",
  };
}

function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function parseCallbackBody(rawBody: string): Record<string, unknown> | null {
  if (!rawBody) return null;
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    // Some providers deliver a JSON array of results.
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object") {
      return parsed[0] as Record<string, unknown>;
    }
    return null;
  } catch {
    // Some callbacks arrive as form-encoded bodies.
    try {
      const params = new URLSearchParams(rawBody);
      const out: Record<string, unknown> = {};
      for (const [key, value] of params.entries()) out[key] = value;
      return Object.keys(out).length > 0 ? out : null;
    } catch {
      return null;
    }
  }
}
