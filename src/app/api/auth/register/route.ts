import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { runApi, ok } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { registerSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { anonymousRateLimitIdentifier, requestContext } from "@/lib/api/context";
import { normalisePhone } from "@/lib/countries";
import { ApiError } from "@/lib/api/errors";
import { isAlreadyRegistered } from "@/lib/auth/provider-errors";
import { logger } from "@/lib/logger";

/**
 * POST /api/auth/register
 *
 * Creates the account and signs the new user straight in. **No confirmation
 * email is sent and none is required.**
 *
 * WHY THIS DOES NOT CALL signUp(). The public signUp() path sends a
 * confirmation email, and whether that email is required is a property of the
 * Supabase PROJECT (`mailer_autoconfirm`), not of this code. While the project
 * required confirmation and had no custom SMTP, every registration failed with
 * `email rate limit exceeded` — the project's built-in mailer allows two auth
 * emails per hour, project-wide — and the account could not be created at all.
 * That made self-serve signup depend on a dashboard setting nobody could change
 * from here.
 *
 * So the account is created with the service role, pre-confirmed, and the
 * session is established immediately. What this costs, stated plainly:
 *
 *   - No proof of address ownership is collected anywhere. Anyone can register
 *     with an address they do not own. The registration rate limiter is the only
 *     brake on automated sign-ups.
 *   - `email_confirmed_at` is set by this server, not by the user clicking a
 *     link, so the email-verification gate can no longer fire. It stays in place
 *     as a safety net for accounts that reach that state another way (changing
 *     the address, which does send a real email).
 *
 * To REVERT to verified sign-ups: restore a `signUp()` call here and configure
 * custom SMTP (see `.freebuff/run.md` §5b-sexies). Do not "fix" the wording
 * below into a claim that an email was sent — none is.
 *
 * The profile, wallet, referral relationship and audit trail are still
 * provisioned server-side by the `handle_new_user` trigger; nothing about them
 * is supplied by the client.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const ctx = requestContext(request);
    await enforceRateLimit(
      RATE_LIMITS.register.bucket,
      anonymousRateLimitIdentifier(ctx),
      RATE_LIMITS.register.limit,
      RATE_LIMITS.register.window,
      RATE_LIMITS.register.mode,
    );

    const input = await parseBody(request, registerSchema);

    const normalised = normalisePhone(input.phone, input.country);
    if (!normalised.ok) {
      throw new ApiError("INVALID_PHONE", normalised.reason, 422, {
        fields: { phone: normalised.reason },
      });
    }

    const admin = createAdminSupabaseClient();

    // Confirm the currency the client asked for is actually enabled.
    const { data: currency } = await admin
      .from("currencies")
      .select("code, enabled")
      .eq("code", input.currency)
      .maybeSingle<{ code: string; enabled: boolean }>();

    if (!currency || !currency.enabled) {
      throw new ApiError(
        "CURRENCY_NOT_SUPPORTED",
        "That currency is not currently supported. Please choose another.",
        422,
        { fields: { currency: "Unsupported currency." } },
      );
    }

    // Validate the referral code before creating anything, so a typo cannot
    // silently produce an orphaned referral.
    let referralCode: string | undefined;
    if (input.referralCode) {
      const { data: referrer } = await admin
        .from("profiles")
        .select("referral_code, status")
        .eq("referral_code", input.referralCode)
        .maybeSingle<{ referral_code: string; status: string }>();

      if (!referrer) {
        throw new ApiError("INVALID_REFERRAL_CODE", "That referral code was not recognised.", 422, {
          fields: { referralCode: "Referral code not found." },
        });
      }
      referralCode = referrer.referral_code;
    }

    /*
      Pre-confirmed, and deliberately so — see the note above. `signup_ip_hash`
      is still recorded so the anti-fraud signals the trigger already collects
      keep working.
    */
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: {
        full_name: input.fullName,
        phone: normalised.e164,
        country: input.country,
        currency: input.currency,
        referral_code: referralCode ?? null,
        signup_ip_hash: ctx.ipHash,
      },
    });

    if (createError || !created?.user) {
      const text = createError?.message ?? "";
      // Never confirm whether an address is registered beyond what the caller
      // already learns by trying.
      logger.warn("register_create_failed", { code: createError?.code, ipHash: ctx.ipHash });

      if (createError?.code === "email_exists" || isAlreadyRegistered(text)) {
        throw new ApiError("EMAIL_TAKEN", "An account with that email address already exists.", 409, {
          fields: { email: "An account with that email already exists." },
        });
      }

      throw new ApiError(
        "REGISTRATION_FAILED",
        "We could not create your account. Please check your details and try again.",
        400,
      );
    }

    // Defensive: the trigger normally provisions this on insert.
    const { error: provisionError } = await admin.rpc("ensure_profile", {
      p_auth_user_id: created.user.id,
      p_email: created.user.email ?? input.email,
      p_metadata: (created.user.user_metadata ?? {}) as Record<string, unknown>,
    });
    if (provisionError) {
      logger.error("register_provision_failed", {
        authUserId: created.user.id,
        error: provisionError.message,
      });
    }

    /*
      Establish the session through the ordinary sign-in path so the cookie is
      set by the same code that serves every later request. If this fails the
      account still exists — the user is told to sign in rather than being left
      on a form that will reject a duplicate registration.
    */
    const supabase = await createServerSupabaseClient();
    const { data: signedIn, error: signInError } = await supabase.auth.signInWithPassword({
      email: input.email,
      password: input.password,
    });

    if (signInError || !signedIn.session) {
      logger.warn("register_signin_after_create_failed", {
        authUserId: created.user.id,
        message: signInError?.message,
      });
      return ok({
        requiresEmailConfirmation: false,
        sessionEstablished: false,
        email: input.email,
        message: "Your account is ready. Please sign in to continue.",
      });
    }

    return ok({
      requiresEmailConfirmation: false,
      sessionEstablished: true,
      email: input.email,
      message: "Your account is ready. Welcome to TaskCash Pro.",
    });
  });
}
