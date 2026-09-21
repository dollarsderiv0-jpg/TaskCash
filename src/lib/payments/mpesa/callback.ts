import { createHmac } from "crypto";
import { isProduction } from "@/lib/env";
import { logger } from "@/lib/logger";
import { pickNumber, pickString } from "@/lib/payments/parse";
import type { NormalizedCallback } from "@/lib/payments/types";
import type { B2cResultPayload, StkCallbackPayload } from "@/lib/payments/mpesa/types";

/**
 * Daraja callback handling.
 *
 * Two things are true at once here, and both matter for money:
 *
 *  1. A callback is *untrusted input*. Safaricom does not sign them. Anyone who
 *     learns the URL can POST a well-formed body claiming a payment succeeded,
 *     so a callback alone must never be sufficient to move money. Every
 *     settlement path re-checks against the provider independently
 *     (an STK status query for collections, a recorded-and-authenticated result
 *     for payouts), and authenticity is recorded alongside the event.
 *  2. A callback is the only place some facts exist. An STK status query
 *     returns the outcome but not the amount or the receipt, so the callback
 *     metadata is where the amount that protects crediting comes from.
 *
 * Authenticity follows the same shape as the SasaPay integration: an IP
 * allowlist, or a shared secret presented as an HMAC signature or a token query
 * parameter. With neither configured the callback is recorded as UNVERIFIED,
 * which is safe because of (1) — it still cannot move money on its own.
 */

export type CallbackAuthenticity = {
  /** True when the request matched a configured mechanism. */
  verified: boolean;
  /** True when a configured mechanism rejected the request outright. */
  rejected: boolean;
  reason: string;
};

export function parseCallbackBody(rawBody: string): Record<string, unknown> | null {
  if (!rawBody) return null;
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * STK callbacks arrive as `{ Body: { stkCallback: { ... } } }`.
 *
 * Returns `null` when the body is not an STK callback at all, so the route can
 * answer 200 and move on rather than inventing a transaction.
 */
export function parseStkCallback(payload: Record<string, unknown>): NormalizedCallback | null {
  const body = payload.Body as StkCallbackPayload["Body"] | undefined;
  const stk = body?.stkCallback;
  if (!stk || typeof stk !== "object") return null;

  const raw = stk as unknown as Record<string, unknown>;
  const resultCode = pickString(raw, ["ResultCode"]);
  const resultDesc = pickString(raw, ["ResultDesc"]);
  const metadata = stkCallbackMetadata(raw);

  const receipt = pickString(metadata, ["MpesaReceiptNumber"]);

  return {
    direction: "COLLECTION",
    providerTransactionId: receipt,
    // The AccountReference we sent is truncated to 12 characters, so it is a
    // display hint only. The authoritative locator is CheckoutRequestID.
    merchantReference: pickString(metadata, ["AccountReference", "BillRefNumber"]),
    checkoutRequestId: pickString(raw, ["CheckoutRequestID"]),
    amount: pickNumber(metadata, ["Amount"]),
    currency: null,
    phone: pickString(metadata, ["PhoneNumber"]),
    outcome: stkOutcome(resultCode, resultDesc),
    resultCode,
    resultDescription: resultDesc,
    raw: payload,
  };
}

/**
 * The B2C result arrives as `{ Result: { ... } }`, and its `ResultParameters`
 * are a list of `{Key, Value}` pairs rather than a map.
 */
export function parseB2cResult(payload: Record<string, unknown>): NormalizedCallback | null {
  const result = (payload as B2cResultPayload).Result;
  if (!result || typeof result !== "object") return null;

  const raw = result as unknown as Record<string, unknown>;
  const params = resultParameterMap(raw);
  const resultCode = pickString(raw, ["ResultCode"]);
  const resultDesc = pickString(raw, ["ResultDesc"]);

  return {
    direction: "DISBURSEMENT",
    // On success this is the M-Pesa receipt; on failure the TransactionID field
    // is still present but is not a payment, so the amount check decides.
    providerTransactionId:
      pickString(params, ["TransactionReceipt"]) ?? pickString(raw, ["TransactionID"]),
    merchantReference: pickString(raw, ["OriginatorConversationID"]),
    // The conversation id is what our withdrawal stores as its provider
    // reference, and therefore what this callback is matched on.
    checkoutRequestId: pickString(raw, ["ConversationID"]),
    amount: pickNumber(params, ["TransactionAmount"]),
    currency: null,
    phone: pickString(params, ["ReceiverPartyPublicName"]),
    outcome: b2cOutcome(resultCode, resultDesc),
    resultCode,
    resultDescription: resultDesc,
    raw: payload,
  };
}

/** Flattens the STK `CallbackMetadata.Item[]` list into a plain lookup. */
export function stkCallbackMetadata(stk: Record<string, unknown>): Record<string, unknown> {
  const metadata = stk.CallbackMetadata as { Item?: Array<Record<string, unknown>> } | undefined;
  return itemListToMap(metadata?.Item, "Name");
}

/** Flattens B2C `ResultParameters.ResultParameter[]` into a plain lookup. */
export function resultParameterMap(result: Record<string, unknown>): Record<string, unknown> {
  const params = result.ResultParameters as
    | { ResultParameter?: Array<Record<string, unknown>> }
    | undefined;
  return itemListToMap(params?.ResultParameter, "Key");
}

function itemListToMap(items: Array<Record<string, unknown>> | undefined, keyField: string) {
  const out: Record<string, unknown> = {};
  for (const item of items ?? []) {
    const key = item?.[keyField];
    if (typeof key === "string" && key) out[key] = item.Value ?? null;
  }
  return out;
}

function stkOutcome(code: string | null, desc: string | null): NormalizedCallback["outcome"] {
  if (code === "0") return "SUCCESS";
  if (code === "1032" || code === "1037" || code === "1019") return "CANCELLED";
  if (code && code !== "") return "FAILED";
  return /success/i.test(desc ?? "") ? "SUCCESS" : "UNKNOWN";
}

function b2cOutcome(code: string | null, desc: string | null): NormalizedCallback["outcome"] {
  if (code === "0") return "SUCCESS";
  if (code && code !== "") return "FAILED";
  return /success/i.test(desc ?? "") ? "SUCCESS" : "UNKNOWN";
}

/**
 * Verifies a callback against whatever this deployment has configured:
 *  - `MPESA_CALLBACK_SECRET`: shared secret, as an HMAC-SHA256 of the raw body
 *    in `x-mpesa-signature`, or as a `token` query parameter (the usual way of
 *    pinning a callback URL, since the URL is then unguessable).
 *  - `MPESA_CALLBACK_IPS`: comma-separated allowlist of Safaricom source IPs.
 *
 * A rejection ends the request. With nothing configured the callback is
 * recorded as unverified — which, for collections, still means the payment is
 * independently confirmed before any credit.
 */
export function checkMpesaCallbackAuthenticity(
  request: Request,
  rawBody: string,
): CallbackAuthenticity {
  const secret = process.env.MPESA_CALLBACK_SECRET?.trim();
  const allowlist = (process.env.MPESA_CALLBACK_IPS ?? "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);

  const url = new URL(request.url);

  if (secret) {
    const signature = request.headers.get("x-mpesa-signature")?.trim();
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
    logger.warn("mpesa_callback_unverified_in_production", {
      hint:
        "Set MPESA_CALLBACK_SECRET (with ?token= on the registered callback URL) or " +
        "MPESA_CALLBACK_IPS. Until then, payouts need manual reconciliation.",
    });
  }

  return {
    verified: false,
    rejected: false,
    reason:
      "No callback verification mechanism configured; settlement relies on independent confirmation.",
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
