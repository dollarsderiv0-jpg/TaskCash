import { getServerEnv } from "@/lib/env";
import { sasapayRequest, pickString, providerSaysOk } from "@/lib/payments/sasapay/client";
import { getAccessToken } from "@/lib/payments/sasapay/auth";
import type { CollectionResponse, ProviderResult } from "@/lib/payments/sasapay/types";

/**
 * Customer-to-Business collection (the deposit path).
 *
 * We only ever *initiate* here. Nothing is credited until the provider's
 * callback or a transaction-status check independently confirms the payment
 * (see verify.ts and the /api/payments/sasapay/callback route).
 */

export type InitiateCollectionInput = {
  /** Our own unique merchant reference for this deposit. */
  merchantReference: string;
  /** Recipient-side number in the format the provider expects. */
  phone: string;
  amount: number;
  currency: string;
  description: string;
  networkCode: string;
  callbackUrl?: string;
};

function merchantCode(): string {
  const env = getServerEnv();
  if (!env.SASAPAY_MERCHANT_CODE) {
    throw new Error("SASAPAY_MERCHANT_CODE is not configured.");
  }
  return env.SASAPAY_MERCHANT_CODE;
}

export function defaultCallbackUrl(): string {
  const env = getServerEnv();
  return env.SASAPAY_CALLBACK_URL ?? `${env.APP_URL}/api/payments/sasapay/callback`;
}

export async function initiateCollection(
  input: InitiateCollectionInput,
): Promise<ProviderResult> {
  const token = await getAccessToken();

  const payload = await sasapayRequest<CollectionResponse>("/payments/request-payment/", {
    method: "POST",
    operation: "c2b.request-payment",
    accessToken: token,
    requestReference: input.merchantReference,
    body: {
      MerchantCode: merchantCode(),
      NetworkCode: input.networkCode,
      PhoneNumber: input.phone,
      Amount: input.amount,
      Currency: input.currency,
      AccountReference: input.merchantReference,
      TransactionDesc: input.description.slice(0, 100),
      CallBackURL: input.callbackUrl ?? defaultCallbackUrl(),
    },
  });

  const raw = payload as unknown as Record<string, unknown>;
  const checkoutRequestId = pickString(raw, ["CheckoutRequestID", "checkout_id", "CheckoutRequestId"]);
  const merchantRequestId = pickString(raw, ["MerchantRequestID", "MerchantRequestId"]);
  const detail = pickString(raw, ["detail", "message", "CustomerMessage", "ResponseDescription"]);

  const accepted = providerSaysOk(raw) || Boolean(checkoutRequestId);

  return {
    ok: accepted,
    // An accepted request is PENDING — the customer still has to approve it.
    outcome: accepted ? "PENDING" : "FAILED",
    checkoutRequestId,
    merchantRequestId,
    providerTransactionId: checkoutRequestId,
    amount: input.amount,
    resultCode: pickString(raw, ["ResponseCode", "ResultCode", "errorCode"]),
    safeMessage: detail ?? (accepted ? "Payment request sent to the customer." : "Payment request was rejected."),
    raw,
  };
}

/**
 * Completes a C2B request that requires an OTP from the customer. Only used
 * when the merchant account is configured for the OTP flow.
 */
export async function processCollectionOtp(input: {
  checkoutRequestId: string;
  verificationCode: string;
}): Promise<ProviderResult> {
  const token = await getAccessToken();

  const payload = await sasapayRequest<CollectionResponse>("/payments/process-payment/", {
    method: "POST",
    operation: "c2b.process-payment",
    accessToken: token,
    requestReference: input.checkoutRequestId,
    body: {
      MerchantCode: merchantCode(),
      CheckoutRequestID: input.checkoutRequestId,
      VerificationCode: input.verificationCode,
    },
  });

  const raw = payload as unknown as Record<string, unknown>;
  return {
    ok: providerSaysOk(raw),
    outcome: providerSaysOk(raw) ? "PENDING" : "FAILED",
    checkoutRequestId: input.checkoutRequestId,
    merchantRequestId: pickString(raw, ["MerchantRequestID"]),
    providerTransactionId: null,
    amount: null,
    resultCode: pickString(raw, ["ResponseCode", "ResultCode"]),
    safeMessage: pickString(raw, ["detail", "message"]) ?? "Payment processing result received.",
    raw,
  };
}
