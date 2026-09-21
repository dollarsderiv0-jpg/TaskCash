import { payoutConfig } from "@/lib/payments/payhero/config";
import { payheroRequest, pickString } from "@/lib/payments/payhero/client";
import { toPayheroMsisdn } from "@/lib/payments/payhero/collect";
import type { ProviderResult, WithdrawResponse } from "@/lib/payments/payhero/types";

/**
 * Payout — the withdrawal path.
 *
 * Only ever called from the admin "approve & send" action, after the withdrawal
 * has been reserved and an approval audit event written. Even a synchronous
 * success here does NOT mark the withdrawal COMPLETED: it is settled only once
 * PayHero confirms, so a payout can never be recorded as paid without provider
 * evidence.
 *
 * PayHero pays out through SasaPay, which is why this takes a `network_code`
 * identifying the recipient's telco rather than only a phone number.
 */

export type DisburseInput = {
  /** Our unique reference for this payout — also the reconciliation key. */
  merchantReference: string;
  phone: string;
  amount: number;
  currency: string;
  description: string;
  /** SasaPay network code for the destination telco. */
  networkCode?: string | null;
};

export async function disburseToCustomer(input: DisburseInput): Promise<ProviderResult> {
  const config = payoutConfig();

  const networkCode = (input.networkCode ?? "").trim() || config.defaultNetworkCode;

  const payload = await payheroRequest<WithdrawResponse>("/withdraw", {
    method: "POST",
    operation: "b2c.disburse",
    /*
      Deliberately NOT retried, even on a transport timeout.

      A retried payout is a duplicated payout, and PayHero gives no idempotency
      guarantee on this endpoint that we could rely on to make a retry safe.
      Recovery is an operator decision made from the reconciliation screen using
      this same merchant reference — which is why the reference is recorded
      before the money is sent.
    */
    retryable: false,
    requestReference: input.merchantReference,
    body: {
      amount: input.amount,
      phone_number: toPayheroMsisdn(input.phone),
      network_code: networkCode,
      external_reference: input.merchantReference,
      callback_url: config.callbackUrl,
      channel: "mobile" as const,
    },
  });

  const raw = payload as unknown as Record<string, unknown>;

  const explicitSuccess = raw.success === true || raw.success === "true";
  const reference = pickString(raw, ["reference", "Reference", "CheckoutRequestID"]);
  const accepted = explicitSuccess || Boolean(reference);
  const detail = pickString(raw, ["message", "detail", "error", "errorMessage"]);

  // An outright refusal that names a reason is terminal; anything else means the
  // payout is in flight and must be left PROCESSING until confirmed.
  const hasExplicitFailure =
    raw.success === false || raw.success === "false" || Boolean(pickString(raw, ["error", "errorMessage"]));

  return {
    ok: accepted,
    outcome: accepted ? "PENDING" : hasExplicitFailure ? "FAILED" : "UNKNOWN",
    checkoutRequestId: reference,
    merchantRequestId: pickString(raw, ["MerchantRequestID", "MerchantRequestId"]),
    providerTransactionId: reference,
    amount: input.amount,
    resultCode: pickString(raw, ["ResponseCode", "ResultCode", "resultCode", "status"]),
    safeMessage:
      detail ?? (accepted ? "Disbursement accepted for processing." : "Disbursement was rejected."),
    raw,
  };
}
