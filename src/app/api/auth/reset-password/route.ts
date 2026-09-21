import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { resetPasswordSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { anonymousRateLimitIdentifier, requestContext } from "@/lib/api/context";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

/**
 * POST /api/auth/reset-password
 *
 * Requires an authenticated session — which, after a recovery link, is the
 * short-lived recovery session Supabase establishes. It cannot be used to
 * change an arbitrary account's password.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const ctx = requestContext(request);
    await enforceRateLimit(
      RATE_LIMITS.passwordReset.bucket,
      anonymousRateLimitIdentifier(ctx),
      RATE_LIMITS.passwordReset.limit,
      RATE_LIMITS.passwordReset.window,
      RATE_LIMITS.passwordReset.mode,
    );

    const input = await parseBody(request, resetPasswordSchema);
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      throw new ApiError(
        "RESET_LINK_INVALID",
        "That reset link is invalid or has expired. Please request a new one.",
        401,
      );
    }

    const { error } = await supabase.auth.updateUser({ password: input.password });
    if (error) {
      logger.warn("password_update_failed", { message: error.message });
      throw new ApiError(
        "PASSWORD_UPDATE_FAILED",
        "The password could not be updated. Please request a new reset link.",
        400,
      );
    }

    return ok({
      message: "Your password has been updated. You can now sign in with your new password.",
    });
  });
}
