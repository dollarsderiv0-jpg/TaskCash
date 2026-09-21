import { z } from "zod";
import { requireSessionUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { normalisePhone, networkCodeForPhone } from "@/lib/countries";
import { initiateCollection } from "@/lib/payments/sasapay/collect";
import { ApiError } from "@/lib/api/errors";
import { verifyAndSettleDeposit } from "@/server/services/deposits";
import type { Deposit } from "@/lib/types";

const schema = z.object({ depositId: z.string().uuid() });

/**
 * POST /api/payments/sasapay/collect
 *
 * Sends (or re-sends) the C2B collection prompt for a deposit that the user
 * already owns and that has not yet reached the provider. It can never create
 * a new deposit, never change the amount, and never credit anything — that
 * still requires provider confirmation.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const session = await requireSessionUser();
    await enforceRateLimit(
      RATE_LIMITS.depositCreate.bucket,
      session.profile.id,
      RATE_LIMITS.depositCreate.limit,
      RATE_LIMITS.depositCreate.window,
      RATE_LIMITS.depositCreate.mode,
    );

    const input = await parseBody(request, schema);
    const admin = createAdminSupabaseClient();

    const { data: deposit } = await admin
      .from("deposits")
      .select("*")
      .eq("id", input.depositId)
      .maybeSingle<Deposit>();

    if (!deposit) {
      throw new ApiError("DEPOSIT_NOT_FOUND", "That deposit could not be found.", 404);
    }
    if (deposit.user_id !== session.profile.id) {
      throw new ApiError("FORBIDDEN", "You do not have access to that record.", 403);
    }
    if (deposit.status === "COMPLETED") {
      return ok({
        status: "COMPLETED",
        message: "This deposit is already confirmed and credited.",
        credited: false,
      });
    }

    // If we already have a provider reference, confirm the existing request
    // instead of creating a second one at the provider.
    if (deposit.provider_reference) {
      const outcome = await verifyAndSettleDeposit(deposit);
      return ok({
        ...outcome,
        reusedExistingRequest: true,
        message:
          outcome.status === "PENDING"
            ? "A payment request is already pending with the provider. Approve the prompt on your phone."
            : outcome.message,
      });
    }

    const normalised = normalisePhone(deposit.phone, session.profile.country);
    if (!normalised.ok) {
      throw new ApiError("INVALID_PHONE", normalised.reason, 422);
    }

    const result = await initiateCollection({
      merchantReference: deposit.merchant_reference,
      phone: normalised.e164,
      amount: Number(deposit.amount),
      currency: deposit.currency,
      description: `TaskCash deposit ${deposit.merchant_reference}`,
      networkCode: networkCodeForPhone(normalised.e164, session.profile.country),
    });

    if (!result.ok) {
      throw new ApiError("DEPOSIT_REJECTED", result.safeMessage, 422);
    }

    await admin
      .from("deposits")
      .update({
        status: "PROCESSING",
        provider_reference: result.checkoutRequestId,
        callback_payload: { initiation: result.raw },
      })
      .eq("id", deposit.id);

    return ok({
      status: "PENDING",
      credited: false,
      merchantReference: deposit.merchant_reference,
      message:
        "Payment request sent. Approve the prompt on your phone. Your wallet is credited only after the provider confirms.",
    });
  });
}
