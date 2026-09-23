/**
 * The bounded retry policy for PayHero, as one testable unit.
 *
 * WHY THIS EXISTS
 * ---------------
 * A throttle is the one provider failure that is worth spending time on. The
 * request was valid, PayHero is up, and a short wait can turn a refused deposit
 * into a queued one — but only if the wait is long enough for the rate-limit
 * window to clear. The transport's original 400ms/800ms backoff was sized for a
 * flaky socket, not for a publisher saying "too many requests": it retried
 * inside the same throttle window and then failed the customer anyway.
 *
 * WHAT IT IS NOT ALLOWED TO DO
 * ----------------------------
 *   - Retry a request PayHero *refused*. A malformed number, a bad amount, an
 *     auth failure and a rejected request all answer the same way next time, so
 *     they are final on the first response. Only a throttle (and the transport
 *     faults the codebase already retried) may be retried.
 *   - Retry forever. Three attempts, then the error stands. The second delay is
 *     the last: `retryDelayMs` returns null once the schedule is spent, and that
 *     null — not a counter compared in three separate places — is what stops it.
 *   - Change the request. Nothing here can: the policy only decides whether to
 *     wait, so the body, the credentials and the `external_reference` are
 *     identical on every attempt by construction.
 *
 * The numbers are exported so the tests assert the real schedule rather than a
 * copy of it.
 */

/** Total attempts, first one included. Two retries. */
export const PAYHERO_MAX_ATTEMPTS = 3;

/**
 * Wait after the 1st and 2nd throttled attempt. There is no third entry because
 * the third attempt is the last one.
 */
export const THROTTLE_RETRY_DELAYS_MS = [1_500, 3_500] as const;

/**
 * Wait after a transport fault or a 5xx, unchanged from the original transport.
 *
 * Deliberately shorter than the throttle schedule: a socket that dropped or a
 * gateway that 502'd is usually ready immediately, whereas a rate limiter has a
 * window measured in seconds. Treating the two the same is what made the
 * throttle retry useless.
 */
export const TRANSIENT_RETRY_DELAYS_MS = [400, 800] as const;

export type RetryKind = "throttle" | "transient";

/**
 * Whether a response is one this policy is allowed to repeat: HTTP 429.
 *
 * DELIBERATELY NARROW, AND WORTH KNOWING WHY
 * -----------------------------------------
 * This integration recognises a throttle in two shapes. One is the standard
 * `429 Too Many Requests`. The other is HTTP **417** carrying
 * `rate limit exceeded: request throttled` — PayHero's own envelope quirk, named
 * in the transport's reader — and the codebase already decided, IN A TEST, that
 * that second shape is NOT retried:
 *
 *     `a throttle is NOT retried — a retry spends the exhausted budget`
 *
 * That reasoning is sound: when a provider says "you are asking too often", a
 * retry spends the very budget that is exhausted. So only the explicit 429 is
 * repeated here, which is also exactly what was asked for. A 417 still gets its
 * own `PROVIDER_THROTTLED` code and the customer-facing "try again shortly"
 * message; it is only the RETRY that stays off.
 *
 * If live traffic turns out to be throttled as 417 rather than 429, this is the
 * one line to widen — and the test above would have to be rewritten with it,
 * because the two decisions cannot both hold.
 */
export function isThrottleResponse(status: number | null): boolean {
  return status === 429;
}

/**
 * How long to wait after `failedAttempt`, or null when there is no retry left.
 *
 * Returned as a delay rather than a boolean so the caller cannot retry without
 * waiting, and cannot wait without having decided to retry.
 */
export function retryDelayMs(kind: RetryKind, failedAttempt: number): number | null {
  const schedule = kind === "throttle" ? THROTTLE_RETRY_DELAYS_MS : TRANSIENT_RETRY_DELAYS_MS;
  const delay = schedule[failedAttempt - 1];
  return typeof delay === "number" ? delay : null;
}

/**
 * Attempts for an operation, given whether it is safe to repeat.
 *
 * `retryable` is optional on the transport's options, and an ABSENT value means
 * a single attempt — the same fail-closed default the transport documents. A
 * payout must never be retried because somebody forgot to say `false`.
 */
export function payheroMaxAttempts(retryable?: boolean): number {
  return retryable === true ? PAYHERO_MAX_ATTEMPTS : 1;
}

/**
 * Which schedule a failed response belongs to, or null when the failure is final.
 *
 * The single place that decides "may this be repeated", so the answer cannot
 * differ between the HTTP branch and the thrown-error branch of the transport.
 */
export function retryKindFor(status: number | null): RetryKind | null {
  if (isThrottleResponse(status)) return "throttle";
  if (status !== null && status >= 500) return "transient";
  return null;
}
