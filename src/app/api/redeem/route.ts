import { z } from "zod";
import { requireSessionUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";

const schema = z.object({
  code: z.string().min(1, "Please enter a code.").max(50),
});

/**
 * POST /api/redeem
 *
 * Redeems a promo code. The actual credit happens inside the
 * `redeem_code` RPC which is SECURITY DEFINER and handles:
 *   · code validation
 *   · expiry check
 *   · redemption limit check
 *   · idempotent wallet credit
 *   · counter increment
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const session = await requireSessionUser();

    await enforceRateLimit(
      "redeem:code",
      session.profile.id,
      10,
      60,
      "open",
    );

    const input = await parseBody(request, schema);

    const admin = createAdminSupabaseClient();

    const { data, error } = await admin.rpc("redeem_code", {
      p_code: input.code.trim(),
    });

    if (error) {
      const msg = error.message ?? "Could not redeem that code.";
      if (msg.includes("EXPIRED")) {
        throw new ApiError("REDEEM_CODE_EXPIRED", "That code has expired.", 400);
      }
      if (msg.includes("EXHAUSTED")) {
        throw new ApiError("REDEEM_CODE_EXHAUSTED", "That code has already been fully redeemed.", 400);
      }
      if (msg.includes("ALREADY_USED")) {
        throw new ApiError("REDEEM_ALREADY_USED", "You have already redeemed this code.", 400);
      }
      if (msg.includes("INVALID")) {
        throw new ApiError("REDEEM_CODE_INVALID", "That code is not valid.", 400);
      }
      throw new ApiError("REDEEM_FAILED", "Could not redeem that code. Please try again.", 500);
    }

    const result = data as { amount: number; remaining: number };

    return ok({
      amount: Number(result.amount),
      remaining: Number(result.remaining),
      message: `KES ${Number(result.amount).toLocaleString()} has been added to your wallet.`,
    });
  });
}
