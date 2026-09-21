import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { forgotPasswordSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { anonymousRateLimitIdentifier, requestContext } from "@/lib/api/context";
import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * POST /api/auth/forgot-password
 *
 * Always reports success, whether or not the address exists. This prevents the
 * endpoint from being used to enumerate registered users.
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

    const input = await parseBody(request, forgotPasswordSchema);
    const env = getServerEnv();
    const supabase = await createServerSupabaseClient();

    const { error } = await supabase.auth.resetPasswordForEmail(input.email, {
      redirectTo: `${env.APP_URL}/reset-password`,
    });

    if (error) {
      logger.warn("password_reset_request_error", { message: error.message });
    }

    return ok({
      message:
        "If an account exists for that address, a reset link is on its way. Check your inbox and spam folder.",
    });
  });
}
