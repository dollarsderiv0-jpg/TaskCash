import { logger } from "@/lib/logger";
import { pickString, providerSaysOk, providerErrorMessage } from "@/lib/payments/parse";
import { darajaRequest, MpesaError } from "@/lib/payments/mpesa/client";
import { getAccessToken } from "@/lib/payments/mpesa/auth";
import { payoutConfig } from "@/lib/payments/mpesa/config";
import { assertWholeShillings, toDarajaMsisdn } from "@/lib/payments/mpesa/stk";
import type { ProviderResult } from "@/lib/payments/types";
import type { B2cResponse } from "@/lib/payments/mpesa/types";

/**
 * B2C — the payout path. Admin-approved withdrawals only.
 *
 * This is only ever called after a withdrawal has been reserved, approved, and
 * an approval audit event written. Even a synchronous success here does NOT
 * mark the withdrawal COMPLETED: the B2C result arrives asynchronously on
 * ResultURL, and only that (or a recorded reconciliation result) settles it.
 *
 * `OriginatorConversationID` is both our reference and the idempotency key:
 * Safaricom rejects a replay with "Duplicate OriginatorConversationID", so a
 * double-clicked approval cannot pay twice even if it races.
 */

export type DisburseInput = {
  /** Our unique reference for this payout — also the idempotency key. */
  merchantReference: string;
  /** Recipient MSISDN in 2547XXXXXXXX form. */
  phone: string;
  amount: number;
  currency: string;
  description: string;
  /** Overrides for the configured defaults, used by tests/diagnostics. */
  resultUrl?: string;
  queueTimeoutUrl?: string;
};

/** Daraja limits `Remarks` to 100 characters. */
const REMARKS_MAX = 100;

export async function disburseToCustomer(input: DisburseInput): Promise<ProviderResult> {
  const config = payoutConfig();
  assertWholeShillings(input.amount);
  const msisdn = toDarajaMsisdn(input.phone);

  if (input.currency !== "KES") {
    throw new MpesaError(
      "CURRENCY_UNSUPPORTED",
      `M-Pesa pays out Kenyan shillings only; this withdrawal is in ${input.currency}.`,
    );
  }

  const token = await getAccessToken();

  const payload = await darajaRequest<B2cResponse>("/mpesa/b2c/v3/paymentrequest", {
    method: "POST",
    operation: "b2c.disburse",
    accessToken: token,
    // Deliberately NOT retried. A retried payout is a duplicated payout;
    // recovery is an operator decision made from the reconciliation screen
    // using this same OriginatorConversationID.
    retryable: false,
    requestReference: input.merchantReference,
    body: {
      OriginatorConversationID: input.merchantReference,
      InitiatorName: config.initiatorName,
      SecurityCredential: config.securityCredential,
      CommandID: config.commandId,
      Amount: input.amount,
      PartyA: config.shortCode,
      PartyB: msisdn,
      Remarks: input.description.slice(0, REMARKS_MAX),
      QueueTimeOutURL: input.queueTimeoutUrl ?? config.queueTimeoutUrl,
      ResultURL: input.resultUrl ?? config.resultUrl,
    },
  });

  const raw = payload as unknown as Record<string, unknown>;
  const conversationId = pickString(raw, ["ConversationID"]);
  const originatorId = pickString(raw, ["OriginatorConversationID"]);
  const accepted = providerSaysOk(raw) && Boolean(conversationId);

  logger.info("mpesa_b2c_initiated", {
    requestReference: input.merchantReference,
    accepted,
    // Never the recipient number or the amount: this line is about whether a
    // request was accepted, and support can correlate on the reference.
  });

  return {
    ok: accepted,
    outcome: accepted ? "PENDING" : "FAILED",
    // The conversation id is what the result callback quotes back, so it is
    // what a withdrawal's provider_reference must store.
    checkoutRequestId: conversationId,
    merchantRequestId: originatorId,
    providerTransactionId: null,
    amount: input.amount,
    resultCode: pickString(raw, ["ResponseCode"]),
    safeMessage:
      pickString(raw, ["ResponseDescription"]) ??
      (accepted
        ? "Disbursement accepted for processing."
        : providerErrorMessage(raw) ?? "The disbursement was rejected."),
    raw,
  };
}
