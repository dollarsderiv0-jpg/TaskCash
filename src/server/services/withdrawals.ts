import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ApiError } from "@/lib/api/errors";
import { logger, logPaymentFailure } from "@/lib/logger";
import { normalisePhone } from "@/lib/countries";
import { formatMoney } from "@/lib/money/format";
// Provider-agnostic: the facade picks M-Pesa or SasaPay from configuration. A
// payout can only be attempted after an administrator approves it, whichever
// gateway ends up sending it.
import {
  disburseToCustomer,
  isPaymentConfigurationError,
  paymentProviderId,
  paymentProviderLabel,
  payoutReadiness,
  verifyDisbursement,
} from "@/lib/payments/provider";
import { assessWithdrawal, recordSignals } from "@/lib/fraud/rules";
import type { Profile, Wallet, Withdrawal } from "@/lib/types";

/**
 * Withdrawal lifecycle.
 *
 * There is NO automatic withdrawal anywhere in this codebase. The sequence is
 * always:
 *
 *   user submits      -> funds move available -> locked  (withdrawal_reserve)
 *   admin approves    -> provider disbursement initiated (status PROCESSING)
 *   provider confirms -> funds leave locked              (withdrawal_complete)
 *   provider fails    -> funds return to available       (withdrawal_release)
 *   admin rejects     -> funds return to available       (withdrawal_release)
 *
 * Each step is a single atomic Postgres function, and each is idempotent.
 */

const PROVIDER_REFERENCE_PREFIX = "TCW";

export type WithdrawalPreview = {
  amount: number;
  fee: number;
  netAmount: number;
  currency: string;
  phone: string;
  minimum: number;
  maximum: number;
  dailyLimit: number;
  /** Flat fee, still used when no percentage is configured. */
  withdrawalFee: number;
  /**
   * Percentage charged on every withdrawal, or 0 when the currency is on a flat
   * fee. The form needs the rate itself rather than a pre-computed amount,
   * because the fee changes as the user types.
   */
  withdrawalFeePercent: number;
  availableBalance: number;
  lockedBalance: number;
  dailyUsed: number;
  dailyRemaining: number;
  requiresKyc: boolean;
  kycStatus: string;
  processingDays: string;
};

export async function getWithdrawalPreview(input: {
  profile: Profile;
  wallet: Wallet;
}): Promise<WithdrawalPreview> {
  const admin = createAdminSupabaseClient();

  const { data: currency } = await admin
    .from("currencies")
    .select("*")
    .eq("code", input.wallet.currency)
    .maybeSingle<{
      min_withdrawal: number;
      max_withdrawal: number;
      withdrawal_fee: number;
      withdrawal_fee_percent: number | null;
    }>();

  const { data: daily } = await admin
    .from("withdrawals")
    .select("amount, status, requested_at")
    .eq("user_id", input.profile.id)
    .not("status", "in", "(REJECTED,FAILED,CANCELLED)")
    .gte("requested_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());

  const dailyUsed = (daily ?? []).reduce((sum, row) => sum + Number((row as { amount: number }).amount), 0);

  const { data: settings } = await admin
    .from("system_settings")
    .select("key, value")
    .in("key", [
      "withdrawals.daily_limit",
      "withdrawals.require_verified_kyc",
      "withdrawals.min_account_age_hours",
    ]);

  const map = new Map(
    (settings ?? []).map((row) => [
      (row as { key: string }).key,
      (row as { value: unknown }).value,
    ]),
  );

  const dailyLimit = Number(map.get("withdrawals.daily_limit") ?? 50_000) || 50_000;

  return {
    amount: 0,
    fee: Number(currency?.withdrawal_fee ?? 0),
    netAmount: 0,
    currency: input.wallet.currency,
    phone: input.profile.phone,
    minimum: Number(currency?.min_withdrawal ?? 100),
    maximum: Number(currency?.max_withdrawal ?? 100_000),
    dailyLimit,
    withdrawalFee: Number(currency?.withdrawal_fee ?? 0),
    /*
      `?? 0` rather than a default rate: a deployment whose database predates
      migration 0026 reads null here and must keep charging its flat fee, not
      silently start charging 10% that the database would not apply.
    */
    withdrawalFeePercent: Number(currency?.withdrawal_fee_percent ?? 0),
    availableBalance: Number(input.wallet.available_balance),
    lockedBalance: Number(input.wallet.locked_balance),
    dailyUsed,
    dailyRemaining: Math.max(0, dailyLimit - dailyUsed),
    requiresKyc: map.get("withdrawals.require_verified_kyc") === true,
    kycStatus: input.profile.kyc_status,
    processingDays: "1–3 business days after approval",
  };
}

export type CreateWithdrawalResult = {
  withdrawalId: string;
  amount: number;
  fee: number;
  netAmount: number;
  currency: string;
  phone: string;
  status: string;
  message: string;
};

export async function createWithdrawal(input: {
  profile: Profile;
  wallet: Wallet;
  amount: number;
  phone: string;
  idempotencyKey: string;
}): Promise<CreateWithdrawalResult> {
  const admin = createAdminSupabaseClient();

  const normalised = normalisePhone(input.phone, input.profile.country);
  if (!normalised.ok) {
    throw new ApiError("INVALID_PHONE", normalised.reason, 422);
  }

  // Risk assessment runs *before* reserving, and only ever recommends a
  // review — it never auto-rejects and never auto-bans.
  const assessment = await assessWithdrawal({
    userId: input.profile.id,
    amount: input.amount,
    currency: input.wallet.currency,
    accountCreatedAt: input.profile.created_at,
    riskScore: input.profile.risk_score ?? 0,
  });

  if (assessment.signals.length > 0) {
    await recordSignals(input.profile.id, assessment.signals);
  }

  const { data, error } = await admin.rpc("withdrawal_reserve", {
    p_user_id: input.profile.id,
    p_amount: input.amount,
    p_phone: normalised.e164,
    p_idempotency_key: input.idempotencyKey,
    p_fee: null,
    p_risk_score: assessment.score,
  });

  // Raised tokens are mapped to friendly messages by the API error mapper.
  if (error) throw error;

  const withdrawal = (Array.isArray(data) ? data[0] : data) as Withdrawal | null;
  if (!withdrawal) {
    throw new ApiError("WITHDRAWAL_CREATE_FAILED", "The withdrawal could not be created.", 500);
  }

  return {
    withdrawalId: withdrawal.id,
    amount: Number(withdrawal.amount),
    fee: Number(withdrawal.fee),
    netAmount: Number(withdrawal.net_amount),
    currency: withdrawal.currency,
    phone: withdrawal.phone,
    status: withdrawal.status,
    message:
      "Withdrawal request submitted. It will be reviewed by the TaskCash Pro administration team " +
      "before any payment is sent. The funds are held and are not available to spend while in review.",
  };
}

export async function getWithdrawalById(id: string): Promise<Withdrawal | null> {
  const admin = createAdminSupabaseClient();
  const { data } = await admin.from("withdrawals").select("*").eq("id", id).maybeSingle<Withdrawal>();
  return data ?? null;
}

export async function listUserWithdrawals(userId: string, limit = 50): Promise<Withdrawal[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("withdrawals")
    .select("*")
    .eq("user_id", userId)
    .order("requested_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as Withdrawal[];
}

/* -------------------------------------------------------------------------- */
/* Admin actions                                                              */
/* -------------------------------------------------------------------------- */

/**
 * APPROVE & SEND.
 *
 * The withdrawal is marked APPROVED and the disbursement is initiated, but it
 * is only marked COMPLETED if the provider confirms. On an immediate failure
 * the held funds are returned to the user's available balance.
 *
 * When no merchant credentials are configured the approval still lands — the
 * administrator's decision is real — but no disbursement is attempted, the
 * funds stay held, and `paymentInitiated` is false. An approval must never be
 * silently converted into a failure, and a payout must never be invented.
 */
export async function approveWithdrawal(input: {
  withdrawalId: string;
  adminId: string;
  adminEmail: string;
  ipHash: string | null;
  userAgent: string | null;
}): Promise<{
  status: string;
  message: string;
  providerReference: string | null;
  paymentInitiated: boolean;
}> {
  const admin = createAdminSupabaseClient();

  const { data: withdrawal, error: loadError } = await admin
    .from("withdrawals")
    .select("*")
    .eq("id", input.withdrawalId)
    .maybeSingle<Withdrawal>();

  if (loadError) throw loadError;
  if (!withdrawal) {
    throw new ApiError("WITHDRAWAL_NOT_FOUND", "That withdrawal request could not be found.", 404);
  }

  if (withdrawal.status !== "PENDING_ADMIN_APPROVAL") {
    throw new ApiError(
      "WITHDRAWAL_NOT_PAYABLE",
      `This withdrawal is already ${withdrawal.status.replace(/_/g, " ").toLowerCase()}.`,
      409,
    );
  }

  // Verify the held funds genuinely exist before promising a payout.
  const { data: wallet } = await admin
    .from("wallets")
    .select("locked_balance, currency")
    .eq("id", withdrawal.wallet_id)
    .maybeSingle<{ locked_balance: number; currency: string }>();

  if (!wallet || Number(wallet.locked_balance) < Number(withdrawal.amount)) {
    logger.error("withdrawal_locked_funds_missing", {
      withdrawalId: withdrawal.id,
      locked: wallet?.locked_balance,
      amount: withdrawal.amount,
    });
    throw new ApiError(
      "LOCKED_FUNDS_MISSING",
      "The held funds for this withdrawal could not be verified. Please review the account ledger.",
      409,
    );
  }

  const now = new Date().toISOString();

  // Step 1: record the approval itself, then move to APPROVED.
  await admin
    .from("withdrawals")
    .update({ status: "APPROVED", admin_id: input.adminId, admin_approved_at: now })
    .eq("id", withdrawal.id)
    .eq("status", "PENDING_ADMIN_APPROVAL");

  const { error: auditError } = await admin.rpc("write_audit", {
    p_admin_id: input.adminId,
    p_user_id: withdrawal.user_id,
    p_action: "WITHDRAWAL_APPROVED",
    p_entity: "withdrawal",
    p_entity_id: withdrawal.id,
    p_description: `Approved withdrawal of ${formatMoney(Number(withdrawal.amount), withdrawal.currency)} to ${withdrawal.phone}`,
    p_metadata: { amount: withdrawal.amount, fee: withdrawal.fee, net: withdrawal.net_amount },
    p_ip_hash: input.ipHash,
    p_user_agent: input.userAgent,
  });
  if (auditError) {
    logger.warn("withdrawal_audit_failed", { withdrawalId: withdrawal.id, error: auditError.message });
  }

  // Step 2: is a payout even possible? Checked before touching the provider, so
  // a missing merchant account cannot be mistaken for a provider rejection.
  const readiness = payoutReadiness();
  if (!readiness.canExecute) {
    logger.warn("withdrawal_payout_blocked", {
      withdrawalId: withdrawal.id,
      mode: readiness.mode,
      missing: readiness.missing,
    });

    await admin.rpc("write_audit", {
      p_admin_id: input.adminId,
      p_user_id: withdrawal.user_id,
      p_action: "WITHDRAWAL_PAYOUT_BLOCKED",
      p_entity: "withdrawal",
      p_entity_id: withdrawal.id,
      p_description: `Approved, but no payout was attempted: ${readiness.mode}.`,
      p_metadata: { mode: readiness.mode, missing: readiness.missing },
      p_ip_hash: input.ipHash,
      p_user_agent: input.userAgent,
    });

    return {
      status: "APPROVED",
      message: readiness.message,
      providerReference: null,
      paymentInitiated: false,
    };
  }

  // Step 3: initiate the provider disbursement.
  const merchantReference = `${PROVIDER_REFERENCE_PREFIX}-${withdrawal.id}`;

  try {
    const result = await disburseToCustomer({
      merchantReference,
      phone: withdrawal.phone,
      amount: Number(withdrawal.net_amount),
      currency: withdrawal.currency,
      description: `TaskCash payout ${withdrawal.id.slice(0, 8)}`,
      channelCode: process.env.SASAPAY_DEFAULT_CHANNEL_CODE ?? "0",
    });

    await admin
      .from("withdrawals")
      .update({
        status: "PROCESSING",
        provider_reference: result.checkoutRequestId ?? merchantReference,
        provider_transaction_id: result.providerTransactionId ?? null,
        provider_request: {
          merchantReference,
          phone: withdrawal.phone,
          amount: Number(withdrawal.net_amount),
          currency: withdrawal.currency,
        },
        provider_response: result.raw,
      })
      .eq("id", withdrawal.id);

    await admin.from("payment_events").insert({
      provider: paymentProviderId(),
      direction: "DISBURSEMENT",
      merchant_reference: merchantReference,
      provider_transaction_id: result.checkoutRequestId,
      outcome: result.outcome,
      signature_valid: true,
      processed: false,
      payload: result.raw,
    });

    // Step 3: settle immediately if the provider already knows the outcome.
    const settlement = await settleWithdrawalFromProvider(withdrawal.id);

    return {
      status: settlement.status,
      message: settlement.message,
      providerReference: result.checkoutRequestId ?? merchantReference,
      paymentInitiated: true,
    };
  } catch (error) {
    /*
      A configuration error must not release the hold.

      The generic branch below returns the user's money to their available balance,
      which is right when Safaricom refused the payout — funds must not be stranded
      for a withdrawal that cannot be paid. It is wrong when the platform itself is
      misconfigured, because the release silently undoes the administrator's
      approval for a reason that has nothing to do with this withdrawal, and it
      reports the platform's gap as the provider's rejection.

      Step 2 already gates on readiness, so this is the belt to that braces: the
      withdrawal stays APPROVED with the funds held — exactly what the readiness
      branch above returns for the same cause, so one platform problem cannot have
      two different money outcomes depending on which line happened to throw.

      Detected by CODE rather than `instanceof`, so it holds for every provider:
      each one defines its own error class, and an `instanceof` test silently
      stops matching the day the active provider changes.
    */
    if (isPaymentConfigurationError(error)) {
      logger.error("withdrawal_payout_not_configured", {
        withdrawalId: withdrawal.id,
        adminId: input.adminId,
      });

      await admin.rpc("write_audit", {
        p_admin_id: input.adminId,
        p_user_id: withdrawal.user_id,
        p_action: "WITHDRAWAL_PAYOUT_BLOCKED",
        p_entity: "withdrawal",
        p_entity_id: withdrawal.id,
        p_description: "Approved, but no payout was attempted: the payment provider is not configured.",
        p_metadata: { mode: "NOT_CONFIGURED" },
        p_ip_hash: input.ipHash,
        p_user_agent: input.userAgent,
      });

      return {
        status: "APPROVED",
        message:
          "Approved. No payment was sent because the payment provider is not configured — the " +
          `funds remain held. Configure ${paymentProviderLabel()}, then send the payout.`,
        providerReference: null,
        paymentInitiated: false,
      };
    }

    const internalErrorId = logPaymentFailure({
      provider: paymentProviderId(),
      operation: "withdrawal.approve",
      requestReference: merchantReference,
      safeMessage: "Disbursement initiation failed",
      error,
    });

    logger.error("withdrawal_disbursement_failed", {
      withdrawalId: withdrawal.id,
      internalErrorId,
    });

    // The payout was never accepted, so release the hold rather than leaving
    // the user's money stranded.
    const { error: releaseError } = await admin.rpc("withdrawal_release", {
      p_withdrawal_id: withdrawal.id,
      p_status: "FAILED",
      p_reason: `Provider disbursement could not be initiated (${internalErrorId}). Funds returned.`,
      p_admin_id: input.adminId,
      p_metadata: { internalErrorId },
    });

    if (releaseError) {
      logger.error("withdrawal_release_failed", {
        withdrawalId: withdrawal.id,
        error: releaseError.message,
      });
      throw new ApiError(
        "WITHDRAWAL_SETTLE_FAILED",
        "The payout could not be sent and the release step failed. Please review this withdrawal manually.",
        500,
      );
    }

    return {
      status: "FAILED",
      message:
        "The provider did not accept the payout. The held funds have been returned to the user's available balance.",
      providerReference: null,
      paymentInitiated: true,
    };
  }
}

/**
 * Reconciles a PROCESSING withdrawal against the provider. Safe to call from
 * a callback, an admin action, or the scheduled reconciliation job — it is
 * idempotent and will never pay twice.
 */
export async function settleWithdrawalFromProvider(
  withdrawalId: string,
): Promise<{ status: string; message: string }> {
  const admin = createAdminSupabaseClient();

  const { data: withdrawal } = await admin
    .from("withdrawals")
    .select("*")
    .eq("id", withdrawalId)
    .maybeSingle<Withdrawal>();

  if (!withdrawal) {
    return { status: "NOT_FOUND", message: "Withdrawal not found." };
  }
  if (withdrawal.status === "COMPLETED") {
    return { status: "COMPLETED", message: "This withdrawal has already been paid." };
  }
  if (["REJECTED", "FAILED", "CANCELLED"].includes(withdrawal.status)) {
    return { status: withdrawal.status, message: "This withdrawal was not paid out." };
  }
  if (withdrawal.status === "PENDING_ADMIN_APPROVAL") {
    return { status: withdrawal.status, message: "This withdrawal still needs administrator approval." };
  }

  const verdict = await verifyDisbursement({
    checkoutRequestId: withdrawal.provider_reference,
    expectedAmount: Number(withdrawal.net_amount),
  });

  if (verdict.confirmed) {
    const { error } = await admin.rpc("withdrawal_complete", {
      p_withdrawal_id: withdrawal.id,
      p_provider_transaction_id: verdict.providerTransactionId,
      p_provider_reference: withdrawal.provider_reference,
      p_response: { verification: verdict.result?.raw ?? null },
    });

    if (error) {
      logger.error("withdrawal_complete_failed", { withdrawalId: withdrawal.id, error: error.message });
      throw new ApiError(
        "WITHDRAWAL_SETTLE_FAILED",
        "The payout was confirmed by the provider but could not be recorded. Please review manually.",
        500,
      );
    }

    return { status: "COMPLETED", message: "Payout confirmed and the withdrawal is now completed." };
  }

  if (verdict.terminal) {
    const { error } = await admin.rpc("withdrawal_release", {
      p_withdrawal_id: withdrawal.id,
      p_status: "FAILED",
      p_reason: verdict.note,
      p_admin_id: withdrawal.admin_id,
      p_metadata: { verification: verdict.result?.raw ?? null },
    });

    if (error) {
      logger.error("withdrawal_release_failed", { withdrawalId: withdrawal.id, error: error.message });
      throw new ApiError(
        "WITHDRAWAL_SETTLE_FAILED",
        "The payout failed and the release step could not be recorded. Please review manually.",
        500,
      );
    }

    return {
      status: "FAILED",
      message: "The provider reported this payout as unsuccessful. The funds have been returned.",
    };
  }

  // As in the deposit path: "no provider amount yet" is not a mismatch, and
  // reporting it as one would misdiagnose a provider outage.
  if (!verdict.amountMatches && verdict.providerAmount !== null) {
    await admin.from("reconciliation_alerts").insert({
      alert_type: "AMOUNT_MISMATCH",
      severity: "CRITICAL",
      entity_type: "withdrawal",
      entity_id: withdrawal.id,
      reference: withdrawal.provider_reference,
      details: {
        expected: Number(withdrawal.net_amount),
        provider: verdict.providerAmount,
        note: verdict.note,
      },
    });
  }

  return {
    status: "PROCESSING",
    message: "The provider has not confirmed this payout yet. It remains in processing.",
  };
}

export async function rejectWithdrawal(input: {
  withdrawalId: string;
  adminId: string;
  reason: string;
  ipHash: string | null;
  userAgent: string | null;
}): Promise<{ status: string; message: string }> {
  const admin = createAdminSupabaseClient();

  const { data: withdrawal } = await admin
    .from("withdrawals")
    .select("*")
    .eq("id", input.withdrawalId)
    .maybeSingle<Withdrawal>();

  if (!withdrawal) {
    throw new ApiError("WITHDRAWAL_NOT_FOUND", "That withdrawal request could not be found.", 404);
  }
  if (withdrawal.status === "COMPLETED") {
    throw new ApiError(
      "WITHDRAWAL_ALREADY_COMPLETED",
      "That withdrawal has already been paid and cannot be rejected.",
      409,
    );
  }
  if (["REJECTED", "FAILED", "CANCELLED"].includes(withdrawal.status)) {
    throw new ApiError("WITHDRAWAL_NOT_PAYABLE", "That withdrawal has already been closed.", 409);
  }
  if (withdrawal.status === "PROCESSING") {
    throw new ApiError(
      "WITHDRAWAL_ALREADY_PROCESSED",
      "A payout is already in flight with the provider. Reconcile it instead of rejecting.",
      409,
    );
  }

  const { error } = await admin.rpc("withdrawal_release", {
    p_withdrawal_id: withdrawal.id,
    p_status: "REJECTED",
    p_reason: input.reason,
    p_admin_id: input.adminId,
    p_metadata: {},
  });

  if (error) throw error;

  await admin.rpc("write_audit", {
    p_admin_id: input.adminId,
    p_user_id: withdrawal.user_id,
    p_action: "WITHDRAWAL_REJECTED",
    p_entity: "withdrawal",
    p_entity_id: withdrawal.id,
    p_description: `Rejected withdrawal of ${formatMoney(Number(withdrawal.amount), withdrawal.currency)}: ${input.reason}`,
    p_metadata: { reason: input.reason, amount: withdrawal.amount },
    p_ip_hash: input.ipHash,
    p_user_agent: input.userAgent,
  });

  return {
    status: "REJECTED",
    message: "The withdrawal was rejected and the held funds were returned to the user's available balance.",
  };
}
