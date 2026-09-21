import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { changeEmailSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { anonymousRateLimitIdentifier, requestContext } from "@/lib/api/context";
import { requireSessionUser } from "@/lib/auth/guards";
import { apiError } from "@/lib/api/errors";
import {
  classifyAuthProviderError,
  emailProviderUnavailable,
  providerThrottled,
} from "@/lib/auth/provider-errors";
import { getServerEnv } from "@/lib/env";
import { describeError, logger } from "@/lib/logger";

/**
 * POST /api/auth/change-email
 *
 * Corrects the address on the SIGNED-IN account. The session identifies the
 * account, so this endpoint cannot be aimed at anyone else.
 *
 * Supabase sends a confirmation to the NEW address and, because the project has
 * `mailer_secure_email_change_enabled`, tells the OLD address that a change was
 * requested. Nothing takes effect until the new address is confirmed — so a
 * typo, or an attacker who has stolen a session, does not silently take over the
 * account.
 *
 * A change to an address that already belongs to another account is refused by
 * the provider; that is reported as a validation error, because it is one.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const ctx = requestContext(request);
    const session = await requireSessionUser();

    await enforceRateLimit(
      "auth:change-email",
      session.profile.id,
      RATE_LIMITS.verificationResend.limit,
      RATE_LIMITS.verificationResend.window,
      RATE_LIMITS.verificationResend.mode,
    );
    await enforceRateLimit(
      "auth:change-email:ip",
      anonymousRateLimitIdentifier(ctx),
      RATE_LIMITS.verificationResend.limit,
      RATE_LIMITS.verificationResend.window,
      RATE_LIMITS.verificationResend.mode,
    );

    const input = await parseBody(request, changeEmailSchema);

    if (input.email.toLowerCase() === (session.email ?? "").toLowerCase()) {
      throw apiError("VALIDATION_ERROR", "That is already the address on this account.", 422, {
        fields: { email: "Enter a different email address." },
      });
    }

    const env = getServerEnv();
    const supabase = await createServerSupabaseClient();

    const { error } = await supabase.auth.updateUser(
      { email: input.email },
      { emailRedirectTo: `${env.APP_URL}/auth/confirm?next=/dashboard` },
    );

    if (error) {
      const text = error.message ?? "";

      if (/already (been )?registered|already exists/i.test(text)) {
        throw apiError("VALIDATION_ERROR", "That email address cannot be used.", 422, {
          fields: { email: "That address is already in use." },
        });
      }
      const failure = classifyAuthProviderError(text);
      if (failure.kind === "email-quota") {
        throw emailProviderUnavailable();
      }
      if (failure.kind === "throttled") {
        throw providerThrottled(failure);
      }
      if (/invalid|valid email/i.test(text)) {
        throw apiError("VALIDATION_ERROR", "Enter a valid email address.", 422, {
          fields: { email: "Enter a valid email address." },
        });
      }

      logger.error("email_change_provider_error", {
        provider: "supabase-auth-smtp",
        userId: session.profile.id,
        error: describeError(error),
      });
      throw apiError(
        "EMAIL_PROVIDER_ERROR",
        "We could not send the email just now. Please contact support if this continues.",
        502,
      );
    }

    logger.info("email_change_requested", { userId: session.profile.id });
    return ok({
      message:
        "Check the new address for a confirmation link. Your account keeps the current address until it is confirmed.",
    });
  });
}
