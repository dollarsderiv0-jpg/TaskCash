import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { resendVerificationSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { anonymousRateLimitIdentifier, requestContext } from "@/lib/api/context";
import { getSessionUser } from "@/lib/auth/session";
import { apiError } from "@/lib/api/errors";
import {
  classifyAuthProviderError,
  emailProviderUnavailable,
  providerThrottled,
} from "@/lib/auth/provider-errors";
import { getServerEnv } from "@/lib/env";
import { describeError, logger } from "@/lib/logger";
import { createHash } from "node:crypto";

/**
 * POST /api/auth/resend-verification
 *
 * Sends a fresh confirmation email. Two callers need this, and they are in
 * different states:
 *
 *  - **Signed in.** The address comes from the session, so this can never be
 *    aimed at somebody else's inbox.
 *  - **Signed out.** This is the common case, and the reason this branch exists:
 *    with confirmation required, an unconfirmed account CANNOT sign in — the
 *    provider refuses it — so a session-scoped-only resend would leave the user
 *    permanently stuck with no way to get another link. The address is taken from
 *    the body instead.
 *
 * That makes the endpoint a potential way to mail-bomb a victim, so the
 * signed-out branch is limited per IP AND per address, and the body is never
 * reflected: the response is the same sentence whether the account exists, is
 * already confirmed, or does not exist at all. No enumeration, no reflection, no
 * way to learn anything except "a request was made".
 *
 * Rate limited per account as well as per IP: either alone is escapable —
 * rotating IPs beats an IP limit, and a shared NAT would make an account limit
 * alone deny innocent neighbours.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const ctx = requestContext(request);
    const session = await getSessionUser();
    const input = await parseBody(request, resendVerificationSchema);

    // Never reflect the address back, and never confirm it exists.
    const message =
      "If this account still needs verification, a new confirmation email has been requested. Check your inbox and spam folder.";

    const ipKey = anonymousRateLimitIdentifier(ctx);
    const email = (session?.email ?? input.email ?? "").trim().toLowerCase();

    await enforceRateLimit(
      RATE_LIMITS.verificationResend.bucket,
      ipKey,
      RATE_LIMITS.verificationResend.limit,
      RATE_LIMITS.verificationResend.window,
      RATE_LIMITS.verificationResend.mode,
    );

    if (session) {
      await enforceRateLimit(
        `${RATE_LIMITS.verificationResend.bucket}:account`,
        session.profile.id,
        RATE_LIMITS.verificationResend.limit,
        RATE_LIMITS.verificationResend.window,
        RATE_LIMITS.verificationResend.mode,
      );
    }

    if (!email) {
      throw apiError(
        "VALIDATION_ERROR",
        "Enter the email address on your account.",
        422,
        { fields: { email: "Enter your email address." } },
      );
    }

    // Per-address limit for the signed-out branch. Hashed, so the counter table
    // never becomes a list of addresses people asked about.
    await enforceRateLimit(
      `${RATE_LIMITS.verificationResend.bucket}:email`,
      createHash("sha256").update(email).digest("hex"),
      RATE_LIMITS.verificationResend.limit,
      RATE_LIMITS.verificationResend.window,
      RATE_LIMITS.verificationResend.mode,
    );

    // Already verified: nothing to send, and no reason to say why.
    if (session && session.emailConfirmed) {
      return ok({ message, state: "ALREADY_VERIFIED" });
    }

    const env = getServerEnv();
    const supabase = await createServerSupabaseClient();

    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: `${env.APP_URL}/auth/confirm?next=/dashboard` },
    });

    if (error) {
      const text = error.message ?? "";

      // An exhausted mail quota and the caller being too quick both contain the
      // words "rate limit" and are not the same problem: one is the platform's
      // dependency, the other is the caller's behaviour.
      const failure = classifyAuthProviderError(text);
      if (failure.kind === "email-quota") {
        logger.error("verification_resend_email_provider_unavailable", {
          userId: session?.profile.id ?? null,
        });
        throw emailProviderUnavailable();
      }
      if (failure.kind === "throttled") {
        logger.warn("verification_resend_rate_limited", { userId: session?.profile.id ?? null });
        throw providerThrottled(failure);
      }

      // An unknown address is not an error the caller may see — that would be
      // the enumeration oracle this endpoint exists without. Supabase reports it
      // as a plain failure, so it is logged and answered uniformly.
      if (/user not found|no user|not found/i.test(text)) {
        logger.info("verification_resend_unknown_address");
        return ok({ message, state: "REQUESTED" });
      }

      // Distinguishing this matters: one is "wait", the other is "your mail
      // provider is down or unconfigured", and sending the user to retry a
      // broken provider forever is the worse failure.
      logger.error("verification_resend_provider_error", {
        provider: "supabase-auth-smtp",
        userId: session?.profile.id ?? null,
        error: describeError(error),
      });
      throw apiError(
        "EMAIL_PROVIDER_ERROR",
        "We could not send the email just now. Please contact support if this continues.",
        502,
      );
    }

    logger.info("verification_resend_requested", { signedIn: Boolean(session) });
    return ok({ message, state: "REQUESTED" });
  });
}
