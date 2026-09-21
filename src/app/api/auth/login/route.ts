import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { runApi, ok } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { loginSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { anonymousRateLimitIdentifier, requestContext } from "@/lib/api/context";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { hashIdentifier } from "@/lib/hash";

/**
 * POST /api/auth/login
 *
 * Rate limited per IP *and* per email hash, so a distributed credential
 * stuffing run against a single account is still throttled. Failures are
 * deliberately indistinguishable.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const ctx = requestContext(request);
    const input = await parseBody(request, loginSchema);

    await enforceRateLimit(
      RATE_LIMITS.login.bucket,
      anonymousRateLimitIdentifier(ctx),
      RATE_LIMITS.login.limit,
      RATE_LIMITS.login.window,
      RATE_LIMITS.login.mode,
    );

    let emailHash: string | null = null;
    try {
      emailHash = hashIdentifier("login-email", input.email);
    } catch {
      emailHash = null;
    }

    if (emailHash) {
      await enforceRateLimit(
        `${RATE_LIMITS.login.bucket}:email`,
        emailHash,
        RATE_LIMITS.login.limit,
        RATE_LIMITS.login.window,
        RATE_LIMITS.login.mode,
      );
    }

    const supabase = await createServerSupabaseClient();

    const { data, error } = await supabase.auth.signInWithPassword({
      email: input.email,
      password: input.password,
    });

    if (error || !data.user) {
      const text = error?.message ?? "";

      // "Email not confirmed" is NOT a wrong password, and reporting it as one is
      // the worst kind of error: the user has the right credentials, is told they
      // are wrong, and retries forever instead of opening their inbox. It is also
      // the one case the user can actually resolve themselves, so it says how.
      if (/email not confirmed|email.*not verified/i.test(text)) {
        logger.warn("login_unverified_email", { ipHash: ctx.ipHash });
        throw new ApiError(
          "EMAIL_NOT_VERIFIED",
          "Confirm your email address before signing in. Check your inbox and spam folder, then use the link we sent.",
          403,
          // Echoed back for the resend form; the caller already knows the address.
          { email: input.email },
        );
      }

      logger.warn("login_failed", { ipHash: ctx.ipHash, message: error?.message });
      throw new ApiError(
        "INVALID_CREDENTIALS",
        "The email address or password is incorrect.",
        401,
      );
    }

    const admin = createAdminSupabaseClient();
    const { data: profile } = await admin
      .from("profiles")
      .select("id, status, role")
      .eq("auth_user_id", data.user.id)
      .maybeSingle<{ id: string; status: string; role: string }>();

    if (!profile) {
      await admin.rpc("ensure_profile", {
        p_auth_user_id: data.user.id,
        p_email: data.user.email ?? input.email,
        p_metadata: (data.user.user_metadata ?? {}) as Record<string, unknown>,
      });
    } else if (profile.status === "SUSPENDED" || profile.status === "CLOSED") {
      // Sign the session back out so a suspended account cannot hold a cookie.
      await supabase.auth.signOut();
      throw new ApiError(
        "ACCOUNT_SUSPENDED",
        "This account is not active. Please contact support.",
        403,
      );
    }

    if (profile) {
      await admin
        .from("profiles")
        .update({ last_login_at: new Date().toISOString() })
        .eq("id", profile.id);
    }

    return ok({
      role: profile?.role ?? "USER",
      message: "Signed in.",
    });
  });
}
