import { z } from "zod";
import { requireSessionUserAndClient } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { enforceRateLimit } from "@/lib/rate-limit";
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
 *
 * The RPC is called with the CALLER's client, not the service-role one, and
 * that is a correctness requirement rather than a preference. `redeem_code`
 * decides whose wallet to credit from `auth.uid()`. The service-role key is not
 * a user token, so `auth.uid()` was null and the function raised UNAUTHORIZED
 * before it ever looked at the code — every redemption answered 500 regardless
 * of the code's validity. The caller's client carries their access token, so
 * `auth.uid()` resolves to them, and because it is still their own client the
 * RLS policies remain exactly as binding as they were.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const { user: session, supabase } = await requireSessionUserAndClient();

    await enforceRateLimit(
      "redeem:code",
      session.profile.id,
      10,
      60,
      "open",
    );

    const input = await parseBody(request, schema);

    const { data, error } = await supabase.rpc("redeem_code", {
      p_code: input.code.trim(),
    });

    if (error) {
      const msg = error.message ?? "Could not redeem that code.";
      /*
        Reachable if the session's token is rejected by PostgREST even though
        this process resolved a user from it. A 401 is the honest answer: telling
        the caller "could not redeem that code" would send them to check a code
        that was never the problem.
      */
      if (msg.includes("UNAUTHORIZED")) {
        throw new ApiError(
          "UNAUTHORIZED",
          "Your session has expired. Please sign in again to redeem a code.",
          401,
        );
      }
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
