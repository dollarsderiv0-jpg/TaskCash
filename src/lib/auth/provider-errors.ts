import { ApiError } from "@/lib/api/errors";
import { humanWait } from "@/lib/duration";

/**
 * Supabase Auth fails for several unrelated reasons that all *look* like the
 * caller is being throttled, and telling them apart changes what the user should
 * do next:
 *
 *   - the project's own sign-up limit            -> waiting helps
 *   - the mail service's send quota              -> waiting helps, but it is the
 *                                                   platform's quota, not the
 *                                                   user's behaviour, so blaming
 *                                                   the user is false and telling
 *                                                   them to check their details
 *                                                   sends them nowhere
 *   - the address is already registered          -> waiting never helps
 *   - SMTP is broken or unconfigured             -> waiting never helps
 *
 * Before this module all four could surface as the same sentence, "Too many
 * attempts. Please wait a moment and try again." That message was produced by
 * the application's own rate limiter, the provider's limiter, and the mail
 * quota alike, so neither the user nor an operator could tell which one had
 * fired -- and the registrations that failed for an email-quota reason looked
 * identical to a user who had genuinely been too quick.
 */

export type ProviderFailureKind = "email-quota" | "throttled" | "unknown";

export type ProviderFailure = {
  kind: ProviderFailureKind;
  /** Only set for "throttled", and only when the provider states a number. */
  retryAfterSeconds: number | null;
};

const EMAIL_QUOTA = [
  /email rate limit exceeded/i,
  /over_email_send_rate_limit/i,
  /email sending.*(limit|quota)/i,
];

const THROTTLED = [
  /for security purposes.*?(\d+)\s*seconds/i,
  /you can only request this after\s*(\d+)\s*seconds/i,
  /rate limit|too many|slow down/i,
];

/**
 * Order matters: the mail quota message contains the words "rate limit", so it
 * must be recognised before the generic throttle patterns, or every exhausted
 * mail quota is reported as the caller misbehaving.
 */
export function classifyAuthProviderError(message: string | null | undefined): ProviderFailure {
  const text = message ?? "";

  if (EMAIL_QUOTA.some((pattern) => pattern.test(text))) {
    return { kind: "email-quota", retryAfterSeconds: null };
  }

  for (const pattern of THROTTLED) {
    const match = pattern.exec(text);
    if (match) {
      const stated = Number(match[1]);
      return {
        kind: "throttled",
        retryAfterSeconds: Number.isFinite(stated) && stated > 0 ? stated : null,
      };
    }
  }

  return { kind: "unknown", retryAfterSeconds: null };
}

/** True when the provider refused because it is already registered. */
export function isAlreadyRegistered(message: string | null | undefined): boolean {
  return /already|registered|exists/i.test(message ?? "");
}

/**
 * "We could not send the email" — a platform-side dependency failure. 503, not
 * 4xx: the request was fine and retrying later is the only fix, and the caller
 * must not be told they did something wrong.
 */
export function emailProviderUnavailable(): ApiError {
  return new ApiError(
    "EMAIL_PROVIDER_ERROR",
    "We could not send your confirmation email right now. Please try again in a few minutes, or contact support if this continues.",
    503,
  );
}

/**
 * The provider is throttling the request itself. A 429 with the real wait when
 * the provider states one, so the caller is not left guessing.
 */
export function providerThrottled(failure: ProviderFailure, fallbackSeconds = 60): ApiError {
  const retryAfterSeconds = failure.retryAfterSeconds ?? fallbackSeconds;
  return new ApiError(
    "RATE_LIMITED",
    `Too many attempts right now. Please try again in ${humanWait(retryAfterSeconds)}.`,
    429,
    { retryAfterSeconds, limit: null },
  );
}
