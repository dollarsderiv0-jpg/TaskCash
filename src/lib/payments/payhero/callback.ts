import { createHmac } from "crypto";
import { isProduction } from "@/lib/env";
import { logger } from "@/lib/logger";
import { pickNumber, pickString, timingSafeEquals } from "@/lib/payments/parse";
import { outcomeFromPayhero } from "@/lib/payments/payhero/verify";
import type { NormalizedCallback, PaymentOutcome } from "@/lib/payments/payhero/types";

/**
 * Callback (webhook) handling.
 *
 * Two things are true at once here:
 *
 *  1. A callback is untrusted input. It is parsed defensively, recorded
 *     verbatim, and never allowed to move money on its own.
 *  2. Because of (1), the *authoritative* confirmation is always the
 *     transaction-status query in verify.ts. Signature and IP checks narrow the
 *     attack surface; they are not the security boundary.
 *
 * PayHero can additionally be configured to notify by JSON POST or by GET; both
 * shapes are normalised here.
 */

export type CallbackAuthenticity = {
  /** True when the request matched a configured verification mechanism. */
  verified: boolean;
  /** True when a configured mechanism rejected the request outright. */
  rejected: boolean;
  reason: string;
};

/** The prefix our own payout references carry. Mirrors withdrawals.ts. */
const DISBURSEMENT_REFERENCE_PREFIX = "TCW-";

/** Normalises a PayHero callback body. */
export function normalizeCallback(
  payload: Record<string, unknown>,
  hint: "COLLECTION" | "DISBURSEMENT" | null = null,
): NormalizedCallback {
  const external = pickString(payload, [
    "external_reference",
    "ExternalReference",
    "account_reference",
    "AccountReference",
  ]);

  const channel = pickString(payload, ["channel", "Channel", "type", "Type"])?.toLowerCase();
  const direction: "COLLECTION" | "DISBURSEMENT" =
    hint ??
    (channel === "withdraw" || channel === "disbursement" || channel === "b2c"
      ? "DISBURSEMENT"
      : external?.startsWith(DISBURSEMENT_REFERENCE_PREFIX)
        ? "DISBURSEMENT"
        : "COLLECTION");

  const status = pickString(payload, ["status", "Status", "transaction_status"]);
  const resultCode = pickString(payload, ["ResultCode", "ResponseCode", "result_code"]);
  const description = pickString(payload, [
    "ResultDesc",
    "message",
    "detail",
    "response_description",
    "errorMessage",
  ]);

  const outcome: PaymentOutcome = outcomeFromPayhero(status, resultCode, description);

  return {
    direction,
    providerTransactionId: pickString(payload, [
      "MpesaReceiptNumber",
      "transaction_code",
      "TransactionCode",
      "receipt_number",
      "provider_transaction_id",
    ]),
    merchantReference: external,
    checkoutRequestId: pickString(payload, ["reference", "Reference", "CheckoutRequestID", "MerchantRequestID"]),
    amount: pickNumber(payload, ["amount", "Amount", "TransactionAmount", "TransAmount"]),
    currency: pickString(payload, ["currency", "Currency"]) ?? "KES",
    phone: pickString(payload, ["phone_number", "PhoneNumber", "MSISDN", "customer_mobile"]),
    outcome,
    resultCode: resultCode ?? status,
    resultDescription: description,
    raw: payload,
  };
}

/**
 * Verifies authenticity against whatever is configured:
 *
 *  - `PAYHERO_CALLBACK_SECRET`: shared secret, supplied either as an
 *    HMAC-SHA256 of the raw body in `x-payhero-signature`, or as a `token`
 *    query parameter on the callback URL. Configure the token form in the
 *    PayHero dashboard if it offers one; otherwise use the IP allowlist.
 *  - `PAYHERO_CALLBACK_IPS`: comma-separated allowlist of PayHero source IPs.
 *
 * If neither is configured the callback is recorded as *unverified*, which is
 * safe: it still cannot move money without passing the mandatory status
 * re-check below.
 */
export function checkCallbackAuthenticity(
  request: Request,
  rawBody: string,
): CallbackAuthenticity {
  const secret = process.env.PAYHERO_CALLBACK_SECRET?.trim();
  const allowlist = (process.env.PAYHERO_CALLBACK_IPS ?? "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);

  const url = new URL(request.url);

  if (secret) {
    const signature = request.headers.get("x-payhero-signature")?.trim();
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
    const ip =
      forwarded?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip")?.trim() ?? "";
    if (!ip || !allowlist.includes(ip)) {
      return { verified: false, rejected: true, reason: "Source IP is not in the allowlist." };
    }
    return { verified: true, rejected: false, reason: "Source IP verified." };
  }

  if (isProduction()) {
    logger.warn("callback_unverified_in_production", {
      provider: "PAYHERO",
      hint: "Set PAYHERO_CALLBACK_SECRET or PAYHERO_CALLBACK_IPS to narrow callback sources.",
    });
  }

  return {
    verified: false,
    rejected: false,
    reason:
      "No callback verification mechanism configured; relying on provider status confirmation.",
  };
}
