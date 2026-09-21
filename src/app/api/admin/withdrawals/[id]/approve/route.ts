import { z } from "zod";
import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody, parseInput } from "@/lib/validation/parse";
import { idSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { requestContext } from "@/lib/api/context";
import { approveWithdrawal, getWithdrawalById } from "@/server/services/withdrawals";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { describeError, logger } from "@/lib/logger";
import { notifyUser } from "@/server/services/notifications";
import { formatMoney } from "@/lib/money/format";

const bodySchema = z.object({
  /** Re-entered administrator password — required above the high-value threshold. */
  adminPassword: z.string().min(1).max(128).optional(),
  acknowledgement: z.literal(true, {
    errorMap: () => ({ message: "Confirm that you have reviewed this withdrawal." }),
  }),
});

/**
 * POST /api/admin/withdrawals/:id/approve
 *
 * APPROVE & SEND. The withdrawal is NOT marked completed here — the provider
 * must confirm the payout first. Above the configured high-value threshold the
 * administrator's password is re-verified against Supabase Auth before the
 * disbursement is initiated.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return runApi(async () => {
    const session = await requireAdmin();
    const reqCtx = requestContext(request);

    await enforceRateLimit(
      RATE_LIMITS.adminMutation.bucket,
      session.profile.id,
      RATE_LIMITS.adminMutation.limit,
      RATE_LIMITS.adminMutation.window,
      RATE_LIMITS.adminMutation.mode,
    );

    const { id } = await ctx.params;
    const withdrawalId = parseInput(idSchema, id);
    const body = await parseBody(request, bodySchema);

    const withdrawal = await getWithdrawalById(withdrawalId);
    if (!withdrawal) {
      throw new ApiError("WITHDRAWAL_NOT_FOUND", "That withdrawal request could not be found.", 404);
    }

    // High-value approvals need a second factor: re-authenticating the admin.
    const admin = createAdminSupabaseClient();
    const { data: thresholdRow } = await admin
      .from("system_settings")
      .select("key, value")
      .in("key", ["withdrawals.high_value_threshold", "withdrawals.require_2fa_above_threshold"]);

    const settingsMap = new Map(
      (thresholdRow ?? []).map((row) => [
        (row as { key: string }).key,
        (row as { value: unknown }).value,
      ]),
    );

    const threshold = Number(settingsMap.get("withdrawals.high_value_threshold") ?? 10_000) || 10_000;
    const requireSecondFactor = settingsMap.get("withdrawals.require_2fa_above_threshold") === true;

    if (requireSecondFactor && Number(withdrawal.amount) >= threshold) {
      if (!body.adminPassword) {
        throw new ApiError(
          "SECOND_FACTOR_REQUIRED",
          "This is a high-value withdrawal. Re-enter your administrator password to confirm.",
          403,
        );
      }

      const supabase = await createServerSupabaseClient();
      const { error } = await supabase.auth.signInWithPassword({
        email: session.profile.email,
        password: body.adminPassword,
      });

      if (error) {
        logger.warn("admin_second_factor_failed", { adminId: session.profile.id });
        await admin.rpc("write_audit", {
          p_admin_id: session.profile.id,
          p_user_id: withdrawal.user_id,
          p_action: "WITHDRAWAL_APPROVAL_2FA_FAILED",
          p_entity: "withdrawal",
          p_entity_id: withdrawal.id,
          p_description: "Second-factor confirmation failed before approving a high-value withdrawal",
          p_metadata: { amount: withdrawal.amount },
          p_ip_hash: reqCtx.ipHash,
          p_user_agent: reqCtx.userAgent,
        });
        throw new ApiError(
          "SECOND_FACTOR_FAILED",
          "That password could not be verified. The withdrawal was not approved.",
          403,
        );
      }
    }

    const result = await approveWithdrawal({
      withdrawalId,
      adminId: session.profile.id,
      adminEmail: session.profile.email,
      ipHash: reqCtx.ipHash,
      userAgent: reqCtx.userAgent,
    });

    /*
      Tell the user their request moved, in the words that match what actually
      happened. The two cases are genuinely different and must not be collapsed:
      a payout was submitted to the provider, or it was approved but no payout is
      possible yet. Promising "being paid" when the provider is not configured
      would be the exact false reassurance this codebase avoids everywhere else.

      Best-effort: a notification failure must never lose an approval that has
      already been recorded and audited.
    */
    try {
      const paymentSubmitted = result.paymentInitiated;
      await notifyUser({
        userId: withdrawal.user_id,
        type: paymentSubmitted ? "WITHDRAWAL_PROCESSING" : "WITHDRAWAL_APPROVED",
        title: paymentSubmitted ? "Withdrawal approved — payment in progress" : "Withdrawal approved",
        message: paymentSubmitted
          ? `Your withdrawal of ${formatMoney(Number(withdrawal.amount), withdrawal.currency)} was approved and the payment is now being processed. We will tell you as soon as it completes.`
          : `Your withdrawal of ${formatMoney(Number(withdrawal.amount), withdrawal.currency)} was approved. It is not paid yet — payouts are not switched on for this deployment, so nothing has left TaskCash Pro.`,
        severity: "INFO",
        link: "/dashboard/withdraw",
        metadata: { withdrawalId, status: result.status },
      });
    } catch (error) {
      logger.warn("withdrawal_approval_notification_failed", {
        withdrawalId,
        error: describeError(error),
      });
    }

    return ok({ ...result, withdrawalId });
  });
}
