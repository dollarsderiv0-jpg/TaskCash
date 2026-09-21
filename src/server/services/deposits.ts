import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger, logPaymentFailure } from "@/lib/logger";
import { normalisePhone, networkCodeForPhone } from "@/lib/countries";
import { formatMoney } from "@/lib/money/format";
// Provider-agnostic: which gateway collects depends on PAYMENTS_PROVIDER, and
// the settlement path below never names one.
import {
  canCollect,
  initiateCollection,
  isPaymentConfigurationError,
  paymentProviderId,
  verifyCollection,
} from "@/lib/payments/provider";
import { missingProviderEnv } from "@/lib/env";
import { getPublicSettings } from "@/lib/settings";
import type { Deposit, Profile, Wallet } from "@/lib/types";
import type { ProviderResult } from "@/lib/payments/types";

/**
 * Deposit lifecycle.
 *
 * A deposit only ever becomes COMPLETED — and only ever creates a ledger
 * credit — after the provider has been asked to confirm the transaction.
 * The client's word is never sufficient.
 */

export function newMerchantReference(): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = Array.from({ length: 8 }, () =>
    "ABCDEFGHJKMNPQRSTUVWXYZ23456789".charAt(Math.floor(Math.random() * 31)),
  ).join("");
  return `TCD-${stamp}-${random}`;
}

export type CreateDepositResult = {
  depositId: string;
  merchantReference: string;
  amount: number;
  currency: string;
  phone: string;
  status: string;
  message: string;
};

export async function createDeposit(input: {
  profile: Profile;
  wallet: Wallet;
  amount: number;
  phone: string;
  idempotencyKey: string;
  ipHash: string | null;
}): Promise<CreateDepositResult> {
  const admin = createAdminSupabaseClient();
  const settings = await getPublicSettings();

  const normalised = normalisePhone(input.phone, input.profile.country);
  if (!normalised.ok) {
    throw new ApiError("INVALID_PHONE", normalised.reason, 422);
  }

  // Amounts are validated against the currency's configured bounds, never a
  // client-supplied limit.
  const currencyRow = await admin
    .from("currencies")
    .select("min_deposit, max_deposit, enabled")
    .eq("code", input.wallet.currency)
    .maybeSingle<{ min_deposit: number; max_deposit: number | null; enabled: boolean }>();

  if (!currencyRow.data || !currencyRow.data.enabled) {
    throw new ApiError("CURRENCY_NOT_SUPPORTED", "This currency is not currently supported.", 400);
  }

  /*
    The effective bounds are the INTERSECTION of the currency's own bounds and the
    platform-wide settings, in the same shape the minimum has always used:

      floor = max(currency.min_deposit, settings.minDeposit)
      ceiling = min(currency.max_deposit, settings.maxDeposit)

    The currency column is the hard per-currency bound (migration 0017 added the
    ceiling; it never existed before, so the only limit on a single deposit was
    what the payment provider would accept). The setting remains the operator's
    day-to-day dial, so raising it in the admin panel can never lift a currency
    above its own ceiling.
  */
  const minAmount = Math.max(Number(currencyRow.data.min_deposit), settings.minDeposit);
  if (input.amount < minAmount) {
    throw new ApiError(
      "BELOW_MINIMUM",
      `The minimum deposit is ${formatMoney(minAmount, input.wallet.currency)}.`,
      422,
    );
  }

  const maxAmount = Math.min(
    currencyRow.data.max_deposit === null || currencyRow.data.max_deposit === undefined
      ? Number.POSITIVE_INFINITY
      : Number(currencyRow.data.max_deposit),
    settings.maxDeposit,
  );
  if (input.amount > maxAmount) {
    throw new ApiError(
      "ABOVE_MAXIMUM",
      `The maximum single deposit is ${formatMoney(maxAmount, input.wallet.currency)}.`,
      422,
    );
  }

  // Idempotency: the same submit key can never create two deposits.
  const { data: claimed } = await admin.rpc("claim_idempotency_key", {
    p_key: input.idempotencyKey,
    p_user: input.profile.id,
    p_scope: "deposit",
  });

  const existing = await admin
    .from("deposits")
    .select("*")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle<Deposit>();

  if (existing.data) {
    return {
      depositId: existing.data.id,
      merchantReference: existing.data.merchant_reference,
      amount: Number(existing.data.amount),
      currency: existing.data.currency,
      phone: existing.data.phone,
      status: existing.data.status,
      message:
        existing.data.status === "PENDING"
          ? "This deposit request is already awaiting confirmation."
          : "This deposit request has already been processed.",
    };
  }

  if (claimed === false) {
    throw new ApiError(
      "DUPLICATE_REQUEST",
      "That request has already been submitted. Please wait for it to finish.",
      409,
    );
  }

  /*
    Fail closed BEFORE a deposit row exists.

    With the provider unconfigured, `initiateCollection` throws from its config
    check — and the row created just above would then be closed as FAILED, so the
    user's history records a payment that failed and the operator's log records a
    provider incident, when in truth no request was ever sent. Checking here means
    a misconfigured platform produces no deposit record at all, and one honest
    error instead of two misleading ones.
  */
  if (!canCollect()) {
    const missing = missingProviderEnv("COLLECT");
    logger.error("deposit_provider_not_configured", { userId: input.profile.id, missing });
    throw new ApiError(
      "PAYMENT_NOT_CONFIGURED",
      "Deposits are unavailable right now: the payment provider is not configured yet. " +
        "Nothing was charged and no money was taken.",
      503,
    );
  }

  const merchantReference = newMerchantReference();

  const { data: deposit, error } = await admin
    .from("deposits")
    .insert({
      user_id: input.profile.id,
      wallet_id: input.wallet.id,
      amount: input.amount,
      currency: input.wallet.currency,
      phone: normalised.e164,
      provider: paymentProviderId(),
      merchant_reference: merchantReference,
      status: "PENDING",
      idempotency_key: input.idempotencyKey,
    })
    .select("*")
    .single<Deposit>();

  if (error || !deposit) {
    logger.error("deposit_insert_failed", { userId: input.profile.id, error: error?.message });
    throw new ApiError("DEPOSIT_CREATE_FAILED", "The deposit could not be created. Please try again.", 500);
  }

  // Ask the provider to collect. Failure here means the deposit is closed as
  // FAILED — no ledger entry is created, and the stored balance never moves.
  try {
    const result = await initiateCollection({
      merchantReference,
      phone: normalised.e164,
      amount: input.amount,
      currency: input.wallet.currency,
      description: `TaskCash deposit ${merchantReference}`,
      networkCode: networkCodeForPhone(normalised.e164, input.profile.country),
    });

    if (!result.ok) {
      await admin
        .from("deposits")
        .update({
          status: "FAILED",
          failure_reason: result.safeMessage,
          callback_payload: { initiation: result.raw },
          completed_at: new Date().toISOString(),
        })
        .eq("id", deposit.id);

      // Safaricom refused the request outright, so its reason code is the real
      // explanation and belongs on the record.
      await recordProviderResult(admin, deposit.id, result);

      throw new ApiError(
        "DEPOSIT_REJECTED",
        result.safeMessage || "The payment request was rejected. Please check the number and try again.",
        422,
      );
    }

    await admin
      .from("deposits")        .update({
          status: "PROCESSING",
          provider_reference: result.checkoutRequestId,
          // Safaricom's id for this STK request. Recorded here because it is the
          // only identifier available while the customer still has the prompt
          // open — which is exactly when they call support. Note that
          // result_code is deliberately NOT written: at this point the code is
          // "0", meaning the prompt was accepted, which would read as a settled
          // payment in any report that filters on result_code.
          merchant_request_id: result.merchantRequestId,
          callback_payload: { initiation: result.raw },
        })
        .eq("id", deposit.id);

    await admin.from("payment_events").insert({
      provider: paymentProviderId(),
      direction: "COLLECTION",
      merchant_reference: merchantReference,
      provider_transaction_id: result.checkoutRequestId,
      outcome: result.outcome,
      signature_valid: false,
      processed: false,
      payload: {
        initiation: result.raw,
      },
    });

    return {
      depositId: deposit.id,
      merchantReference,
      amount: input.amount,
      currency: input.wallet.currency,
      phone: normalised.e164,
      status: "PENDING",
      message:
        "Deposit request sent. Approve the payment prompt on your phone to complete it. " +
        "Your wallet is only credited once the payment is confirmed.",
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;

    /*
      A configuration error is NOT a provider failure.

      `mpesa/errors.ts` states the rule and this is where it was broken: an ApiError
      is re-thrown first, but `PaymentConfigurationError` is a `MpesaError`, so a
      missing credential fell through to the generic branch — logged as a provider
      incident (`logPaymentFailure`, which is how an operator's pager gets spent on
      a platform that has no credentials), recorded on the deposit as "Provider
      initiation failed", and reported to the user as "we could not reach the
      payment provider." We never contacted Safaricom at all. The pre-check above
      keeps this near-unreachable; it stays as the second line of defence, because
      a misreported payment failure is worse than a repeated one.

      Detected by CODE rather than `instanceof`, so it holds for every provider:
      each one defines its own error class, and an `instanceof` test silently
      stops matching the day the active provider changes.
    */
    if (isPaymentConfigurationError(error)) {
      logger.error("deposit_provider_not_configured", {
        userId: input.profile.id,
        depositId: deposit.id,
      });
      await admin
        .from("deposits")
        .update({
          status: "FAILED",
          failure_reason: "Payment provider is not configured. Nothing was charged.",
          completed_at: new Date().toISOString(),
        })
        .eq("id", deposit.id);

      throw new ApiError(
        "PAYMENT_NOT_CONFIGURED",
        "Deposits are unavailable right now: the payment provider is not configured yet. " +
          "Nothing was charged and no money was taken.",
        503,
      );
    }

    const internalErrorId = logPaymentFailure({
      provider: paymentProviderId(),
      operation: "deposit.create",
      requestReference: merchantReference,
      safeMessage: "Provider initiation failed",
      error,
    });

    await admin
      .from("deposits")
      .update({
        status: "FAILED",
        failure_reason: `Provider initiation failed (${internalErrorId})`,
        completed_at: new Date().toISOString(),
      })
      .eq("id", deposit.id);

    throw new ApiError(
      "PAYMENT_PROVIDER_UNAVAILABLE",
      "We could not reach the payment provider. Nothing was charged. Please try again.",
      503,
    );
  }
}

export type VerifyDepositOutcome = {
  status: string;
  credited: boolean;
  duplicate: boolean;
  amount: number;
  currency: string;
  message: string;
};

/**
 * Records what the PROVIDER said, on the deposit row.
 *
 * `status` and `failure_reason` already capture *our* conclusion — FAILED, or a
 * sentence written for a human to read. These columns are the provider's own
 * words, and they are what makes a payment reconcilable months later:
 * MerchantRequestID is the id Safaricom support asks for first, and the result
 * code is the difference between "the customer cancelled" (1032) and "the
 * passkey is wrong" — two situations that otherwise leave identical-looking
 * FAILED rows.
 *
 * Deliberately narrow: metadata only. It never writes a balance, a ledger row or
 * a status, so it cannot influence money in either direction.
 */
async function recordProviderResult(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  depositId: string,
  result: ProviderResult | null,
) {
  if (!result) return;

  const patch: Record<string, string> = {};
  if (result.merchantRequestId) patch.merchant_request_id = result.merchantRequestId;
  if (result.resultCode) patch.result_code = result.resultCode;

  /*
    `safeMessage` normally carries Safaricom's text verbatim, but the provider
    modules substitute a neutral sentence of their own when Safaricom returned no
    description at all. Storing that fallback here would put our words in a
    column whose only purpose is to be trustworthy evidence about what Safaricom
    said — so it is excluded rather than passed off.
  */
  const neutralFallbacks = new Set([
    "Transaction status retrieved.",
    "Payment request sent to the customer.",
    "The payment request was rejected.",
  ]);
  if (result.safeMessage && !neutralFallbacks.has(result.safeMessage)) {
    patch.result_description = result.safeMessage;
  }

  if (Object.keys(patch).length === 0) return;

  const { error } = await admin.from("deposits").update(patch).eq("id", depositId);
  if (error) {
    /*
      Never fatal. The money decision has already been made and durably
      recorded; a missing support identifier must not turn a settled deposit
      into an error response, or Safaricom into a retry loop.
    */
    logger.warn("deposit_provider_result_not_recorded", {
      depositId,
      error: error.message,
    });
  }
}

/**
 * Confirms a deposit against the provider and settles it exactly once.
 */
export async function verifyAndSettleDeposit(
  deposit: Deposit,
): Promise<VerifyDepositOutcome> {
  const admin = createAdminSupabaseClient();

  if (deposit.status === "COMPLETED") {
    return {
      status: "COMPLETED",
      credited: false,
      duplicate: true,
      amount: Number(deposit.amount),
      currency: deposit.currency,
      message: "This deposit has already been credited to your wallet.",
    };
  }

  if (["REJECTED", "CANCELLED", "FAILED", "REVERSED"].includes(deposit.status)) {
    return {
      status: deposit.status,
      credited: false,
      duplicate: false,
      amount: Number(deposit.amount),
      currency: deposit.currency,
      message: deposit.failure_reason ?? "This deposit was not completed.",
    };
  }

  const verdict = await verifyCollection({
    checkoutRequestId: deposit.provider_reference,
    expectedAmount: Number(deposit.amount),
  });

  if (verdict.confirmed) {
    const { data, error } = await admin.rpc("deposit_credit", {
      p_merchant_reference: deposit.merchant_reference,
      p_provider_transaction_id: verdict.providerTransactionId,
      p_payload: { verification: verdict.result?.raw ?? null },
    });

    if (error) {
      logger.error("deposit_credit_failed", {
        merchantReference: deposit.merchant_reference,
        error: error.message,
      });
      throw new ApiError(
        "DEPOSIT_CREDIT_FAILED",
        "The payment is confirmed but the wallet credit could not be recorded. Support has been notified.",
        500,
      );
    }

    // Safaricom's confirmation, in its own words and code.
    await recordProviderResult(admin, deposit.id, verdict.result);

    const row = (Array.isArray(data) ? data[0] : data) as
      | { credited: boolean; duplicate: boolean; tx_id: string | null; bonus_amount: number | null }
      | null;

    // Referral commission and deposit bonus are now handled inside
    // deposit_credit RPC (migration 0015), so no separate call needed.

    return {
      status: "COMPLETED",
      credited: Boolean(row?.credited),
      duplicate: Boolean(row?.duplicate),
      amount: Number(deposit.amount),
      currency: deposit.currency,
      message: "Deposit confirmed and credited to your wallet." +
        (row?.bonus_amount ? " Plus a bonus of KES " +
          Number(row.bonus_amount).toLocaleString() + "!" : ""),
    };
  }

  if (verdict.terminal) {
    await admin.rpc("deposit_fail", {
      p_merchant_reference: deposit.merchant_reference,
      p_reason: verdict.note,
      p_status: verdict.outcome === "CANCELLED" ? "CANCELLED" : "FAILED",
      p_payload: { verification: verdict.result?.raw ?? null },
    });

    // Why Safaricom says it failed — the fact an operator needs to answer a
    // dispute, recorded next to the outcome it explains.
    await recordProviderResult(admin, deposit.id, verdict.result);

    return {
      status: verdict.outcome === "CANCELLED" ? "CANCELLED" : "FAILED",
      credited: false,
      duplicate: false,
      amount: Number(deposit.amount),
      currency: deposit.currency,
      message: verdict.note,
    };
  }

  // Still unresolved: stay PENDING and raise a reconciliation alert so an
  // operator can follow it up. Never credit on an unconfirmed payment.
  await admin
    .from("deposits")
    .update({
      callback_payload: { verification: verdict.result?.raw ?? null, note: verdict.note },
    })
    .eq("id", deposit.id);

  /*
    Only claim a mismatch when a provider amount was actually obtained. Both
    other cases — "the provider was never reached" and "the callback carrying the
    amount has not arrived" — leave `providerAmount` null, and raising "amount
    mismatch" for them would state something we do not know. During a provider
    outage that would fill the queue with a wrong diagnosis, which is worse than
    no alert: an operator chasing a mismatch stops looking for the real fault.
  */
  if (!verdict.amountMatches && verdict.providerAmount !== null) {
    await admin.from("reconciliation_alerts").insert({
      alert_type: "AMOUNT_MISMATCH",
      severity: "HIGH",
      entity_type: "deposit",
      entity_id: deposit.id,
      reference: deposit.merchant_reference,
      details: {
        expected: Number(deposit.amount),
        provider: verdict.providerAmount,
        note: verdict.note,
      },
    });
  }

  return {
    status: "PENDING",
    credited: false,
    duplicate: false,
    amount: Number(deposit.amount),
    currency: deposit.currency,
    message:
      "We are still waiting for the payment provider to confirm this payment. " +
      "Your wallet will be credited as soon as it is confirmed.",
  };
}

export async function listUserDeposits(userId: string, limit = 20): Promise<Deposit[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("deposits")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as Deposit[];
}

export async function getDepositById(depositId: string): Promise<Deposit | null> {
  const admin = createAdminSupabaseClient();
  const { data } = await admin.from("deposits").select("*").eq("id", depositId).maybeSingle<Deposit>();
  return data ?? null;
}

export async function listUserDepositsForUser(userId: string, limit = 20): Promise<Deposit[]> {
  return listUserDeposits(userId, limit);
}
