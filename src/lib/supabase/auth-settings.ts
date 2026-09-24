/**
 * What Supabase Auth says about email — read with the publishable key.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/api/health` used to report email as `configured` or `not_configured` from
 * `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME` and `SMTP_PASSWORD`. Nothing in
 * `src/` reads those variables — the health route itself is the only hit, and
 * they are absent from `src/lib/env.ts` entirely — because this application does
 * not send auth email. Supabase Auth does: password reset
 * (`resetPasswordForEmail` in `src/app/api/auth/forgot-password/route.ts`),
 * signup confirmation and email change all go through it.
 *
 * So the old field was not merely uninformative, it was inverted: setting those
 * four variables in the hosting dashboard would flip the endpoint to
 * `configured` while not one email was sent. That is the worst kind of health
 * check — a green light for the exact failure it appears to rule out.
 *
 * WHAT CAN AND CANNOT BE KNOWN FROM HERE
 * --------------------------------------
 * Supabase Auth exposes a small public settings document at `/auth/v1/settings`,
 * readable with the publishable key. Three of its fields are facts this endpoint
 * can state:
 *
 *   · `external.email`     — is email signup switched on at all
 *   · `mailer_autoconfirm` — are new accounts trusted WITHOUT verifying
 *   · `disable_signup`     — is signup closed
 *
 * What it does NOT expose is whether a custom SMTP server is configured, or
 * whether one works. That lives in the project's auth configuration, reachable
 * only through the Management API, which needs an account-wide personal access
 * token that can create and delete projects. Putting such a token into the
 * running application to satisfy a health check is a far worse trade than an
 * honest `unverifiable`, so that is what the field says.
 *
 * `mailer_autoconfirm` is reported prominently because it is the one auth email
 * setting that is a security fact rather than a delivery detail: with it on,
 * anybody can register an address they do not own and use the account, and no
 * verification email is ever expected. Nothing else in this application can
 * detect that.
 *
 * A failure to read is reported as `settingsReadable: false` with every field
 * `null`. It is never guessed, and it never makes the endpoint unhealthy — an
 * unreadable settings document is not an outage.
 */

export type AuthEmailStatus = {
  /**
   * The service that actually sends auth email. Never this application, which
   * has no mailer at all.
   */
  sentBy: "supabase-auth";
  /** False when Auth could not be read; every field below is then null. */
  settingsReadable: boolean;
  /** From `external.email` — is the email provider available. */
  emailSignupEnabled: boolean | null;
  /** From `disable_signup` — can accounts be created at all. */
  signupEnabled: boolean | null;
  /** From `mailer_autoconfirm` — must a registrant prove the address. */
  verificationRequired: boolean | null;
  /**
   * Whether a custom SMTP server is configured. Always `"unverifiable"` from
   * the application, and reported rather than omitted so that nobody reads its
   * absence as a pass.
   */
  customSmtp: "unverifiable";
  /** One line naming the real problem, or null when there is none to name. */
  warning: string | null;
};

/** Short: a health check should not wait on a settings document. */
const SETTINGS_TIMEOUT_MS = 3_000;

function unreadable(): AuthEmailStatus {
  return {
    sentBy: "supabase-auth",
    settingsReadable: false,
    emailSignupEnabled: null,
    signupEnabled: null,
    verificationRequired: null,
    customSmtp: "unverifiable",
    warning: null,
  };
}

/** A boolean only when Auth actually sent a boolean — never inferred. */
const booleanOrNull = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

export async function readAuthEmailStatus(input: {
  supabaseUrl: string;
  publishableKey: string;
}): Promise<AuthEmailStatus> {
  if (!input.supabaseUrl || !input.publishableKey) return unreadable();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETTINGS_TIMEOUT_MS);

  try {
    const response = await fetch(`${input.supabaseUrl}/auth/v1/settings`, {
      headers: {
        apikey: input.publishableKey,
        authorization: `Bearer ${input.publishableKey}`,
      },
      // A health check is about now, not about a cached five minutes ago.
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) return unreadable();

    const settings = (await response.json()) as {
      mailer_autoconfirm?: unknown;
      disable_signup?: unknown;
      external?: Record<string, unknown>;
    };

    const autoconfirm = booleanOrNull(settings.mailer_autoconfirm);
    const disableSignup = booleanOrNull(settings.disable_signup);
    const emailSignupEnabled =
      typeof settings.external?.email === "boolean" ? settings.external.email : null;

    let warning: string | null = null;
    if (autoconfirm === true) {
      warning =
        "AUTOCONFIRM IS ON — accounts are trusted without the registrant proving the address they signed up with.";
    } else if (emailSignupEnabled === false) {
      warning =
        "EMAIL SIGNUP IS OFF — the email provider is disabled, so nobody can register or reset a password.";
    }

    return {
      sentBy: "supabase-auth",
      settingsReadable: true,
      emailSignupEnabled,
      signupEnabled: disableSignup === null ? null : !disableSignup,
      verificationRequired: autoconfirm === null ? null : autoconfirm === false,
      customSmtp: "unverifiable",
      warning,
    };
  } catch {
    // Unreachable, timed out, or not JSON. Not an outage, and not a pass.
    return unreadable();
  } finally {
    clearTimeout(timer);
  }
}
