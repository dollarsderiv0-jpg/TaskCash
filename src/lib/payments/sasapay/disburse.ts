import { getServerEnv } from "@/lib/env";
import { pickString, providerSaysOk, sasapayRequest } from "@/lib/payments/sasapay/client";
import { getAccessToken } from "@/lib/payments/sasapay/auth";
import { defaultCallbackUrl } from "@/lib/payments/sasapay/collect";
import type { DisbursementResponse, ProviderResult } from "@/lib/payments/sasapay/types";

/**
 * Business-to-Customer disbursement (the payout path).
 *
 * This is only ever called from the admin "approve & send" action, after the
 * withdrawal has been reserved and an approval audit event written. Even a
 * synchronous success here does NOT mark the withdrawal COMPLETED — the
 * withdrawal is only settled once the provider confirms, so a payout can never
 * be recorded as paid without provider evidence.
 */

export type DisburseInput = {
  /** Our unique reference for this payout — also the idempotency key. */
  merchantReference: string;
  phone: string;
  amount: number;
  currency: string;
  description: string;
  channelCode: string;
  callbackUrl?: string;
};

export async function disburseToCustomer(input: DisburseInput): Promise<ProviderResult> {
  const env = getServerEnv();
  if (!env.SASAPAY_MERCHANT_CODE) {
    throw new Error("SASAPAY_MERCHANT_CODE is not configured.");
  }

  const token = await getAccessToken();

  const payload = await sasapayRequest<DisbursementResponse>("/payments/b2c/", {
    method: "POST",
    operation: "b2c.disburse",
    accessToken: token,
    // Deliberately NOT retried automatically. A retried payout is a duplicated
    // payout; recovery is an operator decision made from the reconciliation
    // screen using this same merchant reference.
    retryable: false,
    requestReference: input.merchantReference,
    body: {
      MerchantCode: env.SASAPAY_MERCHANT_CODE,
      Amount: input.amount,
      Currency: input.currency,
      ReceiverNumber: input.phone,
      ChannelCode: input.channelCode,
      CallBackURL: input.callbackUrl ?? defaultCallbackUrl(),
      TransactionDesc: input.description.slice(0, 100),
      AccountReference: input.merchantReference,
    },
  });

  const raw = payload as unknown as Record<string, unknown>;
  const checkoutRequestId = pickString(raw, ["CheckoutRequestID", "checkout_id", "CheckoutRequestId"]);
  const merchantRequestId = pickString(raw, ["MerchantRequestID", "MerchantRequestId"]);
  const accepted = providerSaysOk(raw) || Boolean(checkoutRequestId);
  const hasImmediateFailure =
    !accepted && pickString(raw, ["errorCode", "ResponseCode", "ResultCode"]) !== null;

  return {
    ok: accepted,
    outcome: accepted ? "PENDING" : hasImmediateFailure ? "FAILED" : "UNKNOWN",
    checkoutRequestId,
    merchantRequestId,
    providerTransactionId: checkoutRequestId,
    amount: input.amount,
    resultCode: pickString(raw, ["ResponseCode", "ResultCode", "errorCode"]),
    safeMessage:
      pickString(raw, ["detail", "message", "errorMessage"]) ??
      (accepted ? "Disbursement accepted for processing." : "Disbursement was rejected."),
    raw,
  };
}
