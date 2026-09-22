import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger, logPaymentFailure, describeError } from "@/lib/logger";
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
import { missingProviderEnv, mpesaSandboxMinDeposit } from "@/lib/env";
import { getPublicSettings } from "@/lib/settings";
/*
  A deposit can be payment for a package (migration 0019). The price is read from
  the tier and the activation runs through the same `package_purchase` a wallet
  purchase uses, so M-Pesa and wallet buyers are governed by one set of rules.
*/
import { purchasePackage, resolvePayableTier } from "@/server/services/packages";
import { effectiveDepositBounds, type DepositBounds } from "@/lib/money/limits";
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
  /** The tier this payment buys, when it is a package payment rather than a top-up. */
  packageName?: string | null;
};

/**
 * The deposit bounds that apply to one currency.
 *
 * Read by BOTH the server-side check below and the deposit page, so the numbers
 * the page renders are the numbers the server enforces. They used to be computed
 * separately — the page from `system_settings`, the service from
 * `max(currency, setting)` — which is how the page came to advertise a KES 10
 * minimum that the server refused.
 *
 * Throws CURRENCY_NOT_SUPPORTED for a currency the platform does not accept,
 * which is what the deposit path has always done before contacting a provider.
 */
export async function getDepositBounds(currency: string): Promise<DepositBounds> {
  const admin = createAdminSupabaseClient();
  const settings = await getPublicSettings();

  const currencyRow = await admin
    .from("currencies")
    .select("min_deposit, max_deposit, enabled")
    .eq("code", currency)
    .maybeSingle<{ min_deposit: number; max_deposit: number | null; enabled: boolean }>();

  if (!currencyRow.data || !currencyRow.data.enabled) {
    throw new ApiError("CURRENCY_NOT_SUPPORTED", "This currency is not currently supported.", 400);
  }

  return effectiveDepositBounds({
    currencyMinDeposit: Number(currencyRow.data.min_deposit),
    currencyMaxDeposit: currencyRow.data.max_deposit,
    settingMinDeposit: settings.minDeposit,
    settingMaxDeposit: settings.maxDeposit,
    /*
      Null except during a local Daraja-sandbox run. Passed through here rather
      than conditioned at each call site because this function is the single
      place both the deposit page and the server-side check read their numbers
      from — so the page cannot advertise a sandbox floor the service refuses,
      which is the exact class of mismatch this module was written to end.
    */
    sandboxMinDeposit: mpesaSandboxMinDeposit(),
  });
}

/**
 * True when the provider refused because we are asking too often.
 *
 * Checked by CODE rather than by matching the provider's prose, for the same
 * reason the configuration check is: a message can be reworded by the provider at
 * any time, and a misread throttle is reported to the customer as an outage.
 */
function isProviderThrottleError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "PROVIDER_THROTTLED"
  );
}

/**
 * The provider-agnostic `code` on an error, when it carries one.
 *
 * Read structurally rather than by `instanceof`, for the same reason the
 * configuration check is: every provider defines its own error class, so an
 * `instanceof` test silently stops matching the day the active provider changes.
 */
function providerErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** The HTTP status the provider answered with, when there was one. */
function providerErrorStatus(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const raw =
    (error as { httpStatus?: unknown }).httpStatus ?? (error as { status?: unknown }).status;
  return typeof raw === "number" ? raw : null;
}

/**
 * Refusals we can attribute to a moment when NO provider transaction existed.
 *
 * Every entry here means the provider either answered "no" or was never asked, so
 * there is nothing for reconciliation to match and nothing for the customer's
 * payment history to record.
 */
const CERTAIN_PRE_TRANSACTION_REFUSALS = new Set([
  // An explicit refusal response — `success: false`, or a rejected STK request.
  "PROVIDER_REFUSED",
  // The provider answered 417/429 "rate limit exceeded" instead of accepting.
  "PROVIDER_THROTTLED",
  // We never called the provider at all.
  "PAYMENT_NOT_CONFIGURED",
]);

/**
 * Does this failure leave a deposit record behind?
 *
 * A request the provider refused **before a transaction existed** must not enter
 * the customer's payment history. A FAILED deposit row is a claim that a payment
 * was attempted and failed; when no prompt was ever dispatched and no provider
 * transaction was ever created, that claim is simply false, and it makes the
 * customer's history unreadable exactly when they are trying to retry.
 *
 * The line is not "failed" versus "not failed" — it is **refused** versus **we do
 * not know**:
 *
 *  - *Refused:* an explicit refusal, a throttle, a 4xx, or a platform that was
 *    never configured. The provider told us it did not accept, so no transaction
 *    can exist. The row is removed.
 *  - *Unknown:* unreachable, timeout, or a 5xx. The request may have been
 *    delivered and the answer lost — the provider could have created a
 *    transaction we never saw. The row is kept and closed FAILED, because it is
 *    the only local pointer that lets the reconciliation sweep match an orphan
 *    provider transaction and surface it for manual settlement.
 *
 * Exported so the rule is testable without a database or a provider.
 */
export function providerRefusedBeforeTransaction(refusal: {
  code: string | null;
  httpStatus: number | null;
  providerTransactionId: string | null;
}): boolean {
  // A transaction id means the provider accepted the request. Any refusal came
  // afterwards, and a settled or failed payment must stay reconcilable.
  if (refusal.providerTransactionId) return false;

  if (refusal.code !== null && CERTAIN_PRE_TRANSACTION_REFUSALS.has(refusal.code)) return true;

  return (
    refusal.code === "PROVIDER_HTTP_ERROR" &&
    refusal.httpStatus !== null &&
    refusal.httpStatus < 500
  );
}

/**
 * Records a provider refusal without leaving a false payment in the customer's
 * history.
 *
 * Auditability is preserved two ways when the row is removed: a `payment_events`
 * row — the same table provider callbacks land in, and not customer-visible —
 * and one structured log line. The audit row is written BEFORE the delete, so no
 * path can delete a record and lose the reason with it.
 */
async function recordRefusal(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  deposit: Deposit,
  refusal: {
    code: string;
    message: string;
    raw?: Record<string, unknown> | null;
    httpStatus?: number | null;
    providerTransactionId?: string | null;
  },
) {
  const message = refusal.message || "The payment provider refused the request.";
  const httpStatus = refusal.httpStatus ?? null;

  const dropRecord = providerRefusedBeforeTransaction({
    code: refusal.code,
    httpStatus,
    providerTransactionId: refusal.providerTransactionId ?? null,
  });

  const { error: auditError } = await admin.from("payment_events").insert({
    provider: paymentProviderId(),
    direction: "COLLECTION",
    merchant_reference: deposit.merchant_reference,
    // Deliberately null: the whole point is that the provider never created one.
    provider_transaction_id: null,
    outcome: "FAILED",
    signature_valid: false,
    // Already accounted for by this function; nothing downstream needs to act.
    processed: true,
    duplicate: false,
    payload: {
      refusedBeforeTransaction: dropRecord,
      code: refusal.code,
      message,
      /*
        What the payment was FOR.

        When the record is dropped this event is all that remains, so without
        this the audit trail cannot tell a refused package payment from a refused
        wallet top-up. That is not hypothetical: the first real refusal after
        0019 shipped was a `PROVIDER_THROTTLED` at 07:57 on 2026-09-22, and the
        only reason it could not be traced to the package the buyer was trying to
        buy is that this field did not exist.
      */
      packageId: deposit.package_id ?? null,
      initiation: refusal.raw ?? null,
    },
    error: message.slice(0, 500),
  });

  if (auditError) {
    logger.warn("deposit_refusal_not_recorded", {
      depositId: deposit.id,
      error: auditError.message,
    });
  }

  logger.warn("deposit_refused_by_provider", {
    userId: deposit.user_id,
    merchantReference: deposit.merchant_reference,
    amount: Number(deposit.amount),
    currency: deposit.currency,
    // Named as well as the amount, for the same reason as the audit payload: on a
    // package payment the amount alone does not say which tier was being bought.
    packageId: deposit.package_id ?? null,
    code: refusal.code,
    httpStatus,
    keptRecord: !dropRecord,
    auditError: auditError?.message ?? null,
  });

  const closeAsFailed = () =>
    admin
      .from("deposits")
      .update({
        status: "FAILED",
        failure_reason: message,
        // The provider's raw refusal, when there was one, still belongs on a
        // record we keep. A discarded row's raw lives in the audit event.
        ...(refusal.raw ? { callback_payload: { initiation: refusal.raw } } : {}),
        completed_at: new Date().toISOString(),
      })
      .eq("id", deposit.id);

  if (!dropRecord) {
    await closeAsFailed();
    return;
  }

  const { error: deleteError } = await admin.from("deposits").delete().eq("id", deposit.id);

  if (deleteError) {
    /*
      Removing the row is the only way to keep this out of the customer's
      history, and it may not fail quietly: if the delete is refused, the row is
      CLOSED rather than left PENDING, and the failure to clean up is logged with
      the audit event that already exists for it.
    */
    logger.error("deposit_refusal_cleanup_failed", {
      depositId: deposit.id,
      merchantReference: deposit.merchant_reference,
      error: deleteError.message,
    });
    await closeAsFailed();
  }
}

export async function createDeposit(input: {
  profile: Profile;
  wallet: Wallet;
  amount: number;
  phone: string;
  idempotencyKey: string;
  ipHash: string | null;
  /**
   * Set when this payment is for a package rather than a wallet top-up. The
   * amount is then the tier's price, read here from the package row — the
   * request's own `amount` is ignored, so a buyer cannot name their own price.
   */
  packageId?: string | null;
}): Promise<CreateDepositResult> {
  const admin = createAdminSupabaseClient();

  const normalised = normalisePhone(input.phone, input.profile.country);
  if (!normalised.ok) {
    throw new ApiError("INVALID_PHONE", normalised.reason, 422);
  }

  /*
    Resolved BEFORE any row is written, so a tier that is not on sale, is priced
    in another currency, or is already held produces one honest error and leaves
    no deposit in the customer's history to explain away.
  */
  const tier = input.packageId
    ? await resolvePayableTier({
        userId: input.profile.id,
        packageId: input.packageId,
        currency: input.wallet.currency,
      })
    : null;

  const amount = tier ? tier.price : input.amount;

  // Amounts are validated against the currency's configured bounds, never a
  // client-supplied limit — and from the same source the page renders from, so
  // the two cannot disagree.
  const bounds = await getDepositBounds(input.wallet.currency);

  /*
    Only a top-up is held to the deposit floor.

    `currencies.min_deposit` exists to stop tiny top-ups — a KES 10 deposit costs
    more to process than it moves. A package payment is never tiny and its amount
    is chosen by nobody: it is the tier's own price. Applying the floor to it
    would refuse a legitimately priced package the day an operator prices one
    below the floor, and the floor would be protecting nothing. The ceiling still
    applies: it is a sanity bound on what one payment may move, and a package
    priced above it is a mistake worth refusing.
  */
  if (!tier && amount < bounds.min) {
    throw new ApiError(
      "BELOW_MINIMUM",
      `The minimum deposit is ${formatMoney(bounds.min, input.wallet.currency)}.`,
      422,
    );
  }

  if (amount > bounds.max) {
    throw new ApiError(
      "ABOVE_MAXIMUM",
      `The maximum single deposit is ${formatMoney(bounds.max, input.wallet.currency)}.`,
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
      amount,
      currency: input.wallet.currency,
      phone: normalised.e164,
      provider: paymentProviderId(),
      merchant_reference: merchantReference,
      status: "PENDING",
      idempotency_key: input.idempotencyKey,
      package_id: tier?.id ?? null,
    })
    .select("*")
    .single<Deposit>();

  if (error || !deposit) {
    logger.error("deposit_insert_failed", { userId: input.profile.id, error: error?.message });
    throw new ApiError("DEPOSIT_CREATE_FAILED", "The deposit could not be created. Please try again.", 500);
  }

  /*
    Ask the provider to collect.

    No ledger entry is ever created here and the stored balance never moves. When
    the provider refuses, what happens to the row above depends on whether it can
    have created a transaction — see `recordRefusal`. A refusal that provably
    preceded any transaction removes the row, so the customer's history does not
    record a payment that never existed.
  */
  try {
    const result = await initiateCollection({
      merchantReference,
      phone: normalised.e164,
      amount,
      currency: input.wallet.currency,
      description: tier
        ? `TaskCash ${tier.name} ${merchantReference}`
        : `TaskCash deposit ${merchantReference}`,
      networkCode: networkCodeForPhone(normalised.e164, input.profile.country),
    });

    if (!result.ok) {
      await recordRefusal(admin, deposit, {
        code: "PROVIDER_REFUSED",
        message: result.safeMessage,
        raw: result.raw,
        providerTransactionId: result.providerTransactionId,
      });

      // Only a record that survives can carry the provider's reason code; when
      // the row is discarded, the reason lives in the audit event instead.
      if (result.providerTransactionId) {
        await recordProviderResult(admin, deposit.id, result);
      }

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
      amount,
      currency: input.wallet.currency,
      phone: normalised.e164,
      status: "PENDING",
      packageName: tier?.name ?? null,
      message: tier
        ? `${tier.name} payment request sent. Approve the M-Pesa prompt on your phone ` +
          "and the package activates as soon as the payment is confirmed."
        : "Deposit request sent. Approve the payment prompt on your phone to complete it. " +
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
      // We never called the provider, so no transaction can exist.
      await recordRefusal(admin, deposit, {
        code: "PAYMENT_NOT_CONFIGURED",
        message: "Payment provider is not configured. Nothing was charged.",
      });

      throw new ApiError(
        "PAYMENT_NOT_CONFIGURED",
        "Deposits are unavailable right now: the payment provider is not configured yet. " +
          "Nothing was charged and no money was taken.",
        503,
      );
    }

    /*
      A throttle is not an outage, and reporting it as one is wrong twice over: it
      tells the customer the provider is unreachable when it answered clearly, and
      it hides the one action that actually helps — waiting. PayHero signals this
      as HTTP 417 with "rate limit exceeded: request throttled".
    */
    if (isProviderThrottleError(error)) {
      logger.warn("deposit_provider_throttled", {
        userId: input.profile.id,
        depositId: deposit.id,
      });

      /*
        The provider answered and declined — 417/429 "rate limit exceeded"
        arrives instead of an accepted request, so no transaction exists and the
        customer must not be shown a failed payment for it.
      */
      await recordRefusal(admin, deposit, {
        code: "PROVIDER_THROTTLED",
        message:
          "Payment provider is throttling requests. Nothing was charged; safe to retry shortly.",
        httpStatus: providerErrorStatus(error),
      });

      throw new ApiError(
        "PAYMENT_PROVIDER_THROTTLED",
        "The payment provider is busy and did not accept the request. Nothing was charged. " +
          "Please try again in a few minutes.",
        429,
      );
    }

    const internalErrorId = logPaymentFailure({
      provider: paymentProviderId(),
      operation: "deposit.create",
      requestReference: merchantReference,
      safeMessage: "Provider initiation failed",
      error,
    });

    const providerCode = providerErrorCode(error);
    const providerStatus = providerErrorStatus(error);

    /*
      A 4xx that is not a throttle is the provider *rejecting* the request: it
      answered, and declined. Calling that "we could not reach the payment
      provider" is the same falsehood the throttle wording used to tell — the
      provider was reached, and the fault is in the request. 401/403 are
      excluded: those are OUR credentials failing, which is a platform problem
      and must not be blamed on the customer's input.
    */
    const rejectedByProvider =
      providerCode === "PROVIDER_HTTP_ERROR" &&
      providerStatus !== null &&
      providerStatus >= 400 &&
      providerStatus < 500 &&
      providerStatus !== 401 &&
      providerStatus !== 403;

    // Whether this keeps its record depends on the failure: a 4xx is a refusal,
    // while unreachable/timeout/5xx are an unknown outcome that has to stay
    // reconcilable.
    await recordRefusal(admin, deposit, {
      code: providerCode ?? "PROVIDER_UNAVAILABLE",
      message: `Provider initiation failed (${internalErrorId})`,
      httpStatus: providerStatus,
    });

    if (rejectedByProvider) {
      throw new ApiError(
        "DEPOSIT_REJECTED",
        "The payment provider rejected the request. Nothing was charged — please check the " +
          "number and try again.",
        422,
      );
    }

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
  /**
   * The package this payment activated, when it bought one. Null on a wallet
   * top-up, and on a package payment whose activation has not happened yet —
   * which is a state the caller must be able to tell apart from "not a package
   * payment", so it is null-vs-object rather than a boolean.
   */
  packageActivated?: { packageName: string } | null;
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
 * Whether a purchase was refused because the tier is already held.
 *
 * The token has to be read out of the MESSAGE, not the code. `package_purchase`
 * raises `PACKAGE_ALREADY_ACTIVE` as a Postgres exception, so PostgREST answers
 * `{ message: "PACKAGE_ALREADY_ACTIVE", code: "P0001" }` — the token in the
 * message, and the code left as the generic raise class. Two ways to get this
 * wrong, and the first version of this function managed both at once: matching on
 * `code` never fires against a real database, and reaching the message through
 * `instanceof Error` finds nothing at all, because that response is a plain
 * object. It passed a stub that set the code and would have done nothing in
 * production.
 */
function isAlreadyActiveError(error: unknown): boolean {
  if (providerErrorCode(error) === "PACKAGE_ALREADY_ACTIVE") return true;

  // Same widening the shared error mapper uses to find a raised token, so this
  // matches what `toApiError` matches.
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error ?? "");

  return message.includes("PACKAGE_ALREADY_ACTIVE");
}

/**
 * What happened to the package a payment was for.
 *
 * Three outcomes rather than a boolean, because the caller has to SAY something
 * different for each and two of them are easy to conflate: a package that was
 * already active is not a failure (the buyer has what they paid for and the credit
 * is in their wallet), while an activation that was refused is a real problem they
 * need to act on. `null` means there was nothing to do — either the payment was a
 * wallet top-up, or its package was activated on an earlier call.
 */
type PackageActivation =
  | { kind: "ACTIVATED"; packageName: string }
  | { kind: "ALREADY_HELD" }
  | { kind: "FAILED" }
  | null;

/**
 * Activates the package a deposit paid for.
 *
 * Only ever called once the wallet credit is durably recorded, and safe to call
 * again: it no-ops when the deposit already carries `package_activated_at`, and
 * `package_purchase` holds an advisory lock of its own.
 *
 * It never throws. By the time it runs the money decision is made and recorded;
 * a failed activation must not turn a settled payment into an error response, nor
 * make the provider retry a callback it has already delivered successfully. What
 * it must not do either is fail quietly — a failure leaves
 * `package_activated_at` NULL, which is the flag the repair path in
 * `verifyAndSettleDeposit` reads, so the very next question about this deposit
 * tries again.
 */
async function activateDepositPackage(
  deposit: Deposit,
  admin: ReturnType<typeof createAdminSupabaseClient>,
): Promise<PackageActivation> {
  if (!deposit.package_id || deposit.package_activated_at) return null;

  const markActivated = async (purchaseId: string | null) => {
    await admin
      .from("deposits")
      .update({
        package_activated_at: new Date().toISOString(),
        package_purchase_id: purchaseId,
      })
      .eq("id", deposit.id);
  };

  try {
    const purchase = await purchasePackage({
      userId: deposit.user_id,
      packageId: deposit.package_id,
    });

    await markActivated(purchase.purchaseId);

    logger.info("deposit_package_activated", {
      depositId: deposit.id,
      packageId: deposit.package_id,
      purchaseId: purchase.purchaseId,
    });

    return { kind: "ACTIVATED", packageName: purchase.packageName };
  } catch (error) {
    const code = providerErrorCode(error);

    /*
      The tier is already held.

      Reachable when the buyer bought the same package another way between the
      payment request and its confirmation. Charging them again would be wrong
      and retrying forever would only fill the log — the package they paid for is
      active either way, and the credit is in their wallet to spend, so this is
      recorded as satisfied and stated as the exception it is.
    */
    if (isAlreadyActiveError(error)) {
      await markActivated(null);

      logger.warn("deposit_package_already_held", {
        depositId: deposit.id,
        packageId: deposit.package_id,
      });

      return { kind: "ALREADY_HELD" };
    }

    logger.error("deposit_package_activation_failed", {
      depositId: deposit.id,
      packageId: deposit.package_id,
      code,
      error: describeError(error),
    });

    return { kind: "FAILED" };
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
    /*
      The repair path.

      A deposit that is COMPLETED but whose package was never activated is the
      state a crash between the credit and the activation leaves behind — and
      because the credit is the lock that decides who may activate, no other
      caller will ever finish the job. Asking about the deposit again is the
      natural moment to do it, and it is free when there is nothing to repair.
    */
    const repaired = await activateDepositPackage(deposit, admin);

    return {
      status: "COMPLETED",
      credited: false,
      duplicate: true,
      amount: Number(deposit.amount),
      currency: deposit.currency,
      packageActivated: repaired?.kind === "ACTIVATED" ? { packageName: repaired.packageName } : null,
      message:
        repaired?.kind === "ACTIVATED"
          ? `${repaired.packageName} is now active.`
          : "This deposit has already been credited to your wallet.",
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

    /*
      Activate the package THIS payment bought — but only if this call is the one
      that recorded the credit.

      `deposit_credit` is the lock that decides ownership of a settlement, and it
      reports every caller it turned away as `duplicate`. Gating on `credited`
      therefore means a replayed callback, a second poll and a reconciliation
      sweep that all reach the same deposit cannot buy the package more than once:
      exactly one of them sees `credited`, and only that one activates.
    */
    const activation = row?.credited
      ? await activateDepositPackage(deposit, admin)
      : null;

    const creditedMessage =
      "Deposit confirmed and credited to your wallet." +
      (row?.bonus_amount
        ? " Plus a bonus of KES " + Number(row.bonus_amount).toLocaleString() + "!"
        : "");

    /*
      Every outcome gets its own sentence, because they are not interchangeable
      and two of them are the ones worth getting right:

        · activated     — say so, and nothing else
        · already held  — the buyer has the package and their money back in the
                          wallet; reporting this as a failure would send them to
                          support over nothing
        · failed        — the money is safely in the wallet but the package is
                          NOT active, and claiming success would leave them
                          waiting for something that is not coming
    */
    const message =
      activation?.kind === "ACTIVATED"
        ? `${activation.packageName} is now active.`
        : activation?.kind === "ALREADY_HELD"
          ? "This package was already active on your account, so the payment was " +
            "credited to your wallet instead of buying a second one."
          : activation?.kind === "FAILED"
            ? "Your payment was confirmed, but the package could not be activated. " +
              "The money is in your wallet — please activate the package from the " +
              "Packages page, and contact support if it is refused."
            : creditedMessage;

    return {
      status: "COMPLETED",
      credited: Boolean(row?.credited),
      duplicate: Boolean(row?.duplicate),
      amount: Number(deposit.amount),
      currency: deposit.currency,
      packageActivated:
        activation?.kind === "ACTIVATED" ? { packageName: activation.packageName } : null,
      message,
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
