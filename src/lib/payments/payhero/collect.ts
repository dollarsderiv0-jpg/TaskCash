import { collectionConfig } from "@/lib/payments/payhero/config";
import { payheroRequest, pickString, providerSaysOk } from "@/lib/payments/payhero/client";
import type { ProviderResult, StkPushResponse } from "@/lib/payments/payhero/types";

/**
 * Customer-to-business collection — the deposit path.
 *
 * We only ever *initiate* here. Nothing is credited until PayHero's callback or
 * an independent transaction-status check confirms the payment (see verify.ts).
 *
 * `ok: true` means exactly "the customer has been prompted". PayHero reports a
 * dispatched prompt as `status: "QUEUED"`, and a queued prompt is not a payment:
 * the customer can still cancel it, and the line can still be out of float.
 */

export type InitiateCollectionInput = {
  /** Our own unique reference for this deposit — also the dedupe key. */
  merchantReference: string;
  /** Recipient number. E.164 (+254…) or local; normalised to MSISDN digits. */
  phone: string;
  amount: number;
  /** PayHero's v2 collection endpoint is Kenya-shillings only. */
  currency: string;
  description: string;
  callbackUrl?: string;
};

/**
 * PayHero accepts `2547XXXXXXXX` and `07XXXXXXXX`. We always send the
 * international-digits form, which is unambiguous.
 */
export function toPayheroMsisdn(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  return digits;
}

export async function initiateCollection(input: InitiateCollectionInput): Promise<ProviderResult> {
  const config = collectionConfig();

  const payload = await payheroRequest<StkPushResponse>("/payments", {
    method: "POST",
    operation: "c2b.stk-push",
    // Safe to retry: the same `external_reference` identifies this attempt, and
    // a repeated request prompts the same customer once per attempt rather than
    // creating a second payable obligation.
    retryable: true,
    requestReference: input.merchantReference,
    body: {
      amount: input.amount,
      phone_number: toPayheroMsisdn(input.phone),
      channel_id: config.channelId,
      external_reference: input.merchantReference,
      callback_url: input.callbackUrl ?? config.callbackUrl,
      provider: "m-pesa" as const,
    },
  });

  const raw = payload as unknown as Record<string, unknown>;

  /**
   * PayHero answers HTTP 201 with `{ success: true, status: "QUEUED", ... }`
   * and refuses with HTTP 200 and `{ success: false, error: "…" }` — so the
   * HTTP status alone cannot be trusted, and `providerSaysOk` alone is not
   * enough either (it does not read `success`).
   */
  const explicitSuccess = raw.success === true || raw.success === "true";
  const payheroReference = pickString(raw, ["reference", "Reference"]);
  const checkoutRequestId = pickString(raw, ["CheckoutRequestID", "CheckoutRequestId"]);
  const accepted = explicitSuccess || Boolean(payheroReference) || Boolean(checkoutRequestId);

  const detail = pickString(raw, ["message", "detail", "error", "errorMessage", "CustomerMessage"]);

  return {
    ok: accepted,
    // Accepted means the prompt was dispatched — PENDING, never SUCCESS.
    outcome: accepted ? "PENDING" : "FAILED",
    /*
      The reference we keep is PayHero's own, because that is the key their
      transaction-status endpoint is documented to accept. `CheckoutRequestID`
      is Safaricom's id, useful in support conversations, and is reported
      separately rather than lost.
    */
    checkoutRequestId: payheroReference ?? checkoutRequestId,
    merchantRequestId: pickString(raw, ["MerchantRequestID", "MerchantRequestId"]),
    providerTransactionId: payheroReference ?? checkoutRequestId,
    amount: input.amount,
    resultCode: pickString(raw, ["ResponseCode", "ResultCode", "resultCode", "status"]),
    safeMessage:
      detail ?? (accepted ? "Payment request sent to the customer." : "Payment request was rejected."),
    raw,
  };
}

/** True when the provider-level response reads as an outright refusal. */
export function collectionWasRefused(result: ProviderResult): boolean {
  const raw = result.raw;
  if (raw.success === false || raw.success === "false") return true;
  if (providerSaysOk(raw)) return false;
  return Boolean(pickString(raw, ["error", "errorMessage", "detail"])) && !result.ok;
}
