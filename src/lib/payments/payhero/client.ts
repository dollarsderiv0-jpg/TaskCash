import { logPaymentFailure } from "@/lib/logger";
import { sleep } from "@/lib/utils";
import {
  payheroCredentials,
  payheroTimeoutMs,
  resolveApiBase,
} from "@/lib/payments/payhero/config";
import { PayHeroError } from "@/lib/payments/payhero/errors";
import {
  payheroMaxAttempts,
  retryDelayMs,
  retryKindFor,
} from "@/lib/payments/payhero/retry";

/**
 * Low-level PayHero HTTP transport.
 *
 * PayHero authenticates with **HTTP Basic** on every request — an API username
 * and password issued in the dashboard, not an OAuth token. There is no token
 * endpoint and therefore nothing to cache or refresh.
 *
 * Fail-safe behaviour that matters for a real-money product:
 *  - With credentials absent we THROW. We never fabricate a successful payment.
 *    PayHero has no sandbox host and this integration has no simulator, so there
 *    is no code path at all that invents a provider response.
 *  - The credential is read from `process.env` at call time and never leaves the
 *    server. Nothing here is importable from a client component: every value it
 *    touches is a server-only variable, and the module is only ever reached
 *    through `@/lib/payments/provider` or an API route.
 */

export { PayHeroError } from "@/lib/payments/payhero/errors";

/**
 * Builds the `Authorization` header value.
 *
 * Exported for the one caller that needs to prove the credential is present and
 * correctly shaped without sending a request; never logged, never returned in a
 * response body.
 */
export function payheroAuthHeader(): string {
  const { username, password } = payheroCredentials();
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

type FetchOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  /**
   * Only idempotent operations may be retried. A collection is retried on
   * transport failure because PayHero deduplicates on `external_reference` and
   * the customer is prompted at most once per channel request; a *disbursement*
   * is never retried, because a retried payout is a duplicated payout.
   */
  retryable?: boolean;
  operation: string;
  requestReference?: string | null;
};

export async function payheroRequest<T>(path: string, options: FetchOptions): Promise<T> {
  const base = resolveApiBase();
  const url = `${base.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  const timeout = payheroTimeoutMs();
  /*
    The attempt bound and every delay live in `retry.ts`, together, so the number
    of attempts and the schedule they consume cannot drift apart.
  */
  const attempts = payheroMaxAttempts(options.retryable);
  const authorization = payheroAuthHeader();

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: options.method ?? "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        cache: "no-store",
      });

      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = { raw: text.slice(0, 500) };
      }

      if (!response.ok) {
        const asRecord = payload as Record<string, unknown> | null;

        /*
          PayHero's error envelope is `{ error_code, error_message, status_code }`.
          Those names were absent from this reader, so every PayHero refusal was
          reduced to the bare "PayHero responded with HTTP 417" and the actual
          reason — "rate limit exceeded: request throttled" — was discarded. An
          opaque payment failure is the expensive kind: it is indistinguishable
          from an outage and sends an operator looking in the wrong place.
        */
        const safe =
          (typeof asRecord?.error_message === "string" && asRecord.error_message) ||
          (typeof asRecord?.detail === "string" && asRecord.detail) ||
          (typeof asRecord?.error === "string" && asRecord.error) ||
          (typeof asRecord?.errorMessage === "string" && asRecord.errorMessage) ||
          (typeof asRecord?.message === "string" && asRecord.message) ||
          `PayHero responded with HTTP ${response.status}`;

        const providerCode =
          typeof asRecord?.error_code === "string" ? asRecord.error_code : null;

        /*
          A throttle is its own condition, not a bad request and not an outage:
          the request was valid and the provider is up — we are simply asking too
          often. It gets its own code so the deposit path can say "try again
          shortly" instead of "invalid request" or "we could not reach the
          provider", AND its own, longer retry schedule (see retry.ts).

          That second half was missing. The previous 400ms/800ms backoff spent
          both attempts inside the same rate-limit window and then failed the
          customer anyway, so the retry existed without ever being able to
          succeed — which made a throttle indistinguishable from a refusal.
        */
        const throttled = /rate limit|throttl/i.test(safe);
        const code = throttled ? "PROVIDER_THROTTLED" : "PROVIDER_HTTP_ERROR";

        /*
          Only a throttle or a 5xx is worth repeating. A 4xx that is not a
          throttle answers identically next time — a bad number, a bad amount, a
          rejected request — so it is final on the first response.
        */
        const retryKind = retryKindFor(response.status);
        const retryDelay = retryKind === null ? null : retryDelayMs(retryKind, attempt);

        lastError = new PayHeroError(code, safe, response.status, asRecord);

        if (retryDelay !== null && attempt < attempts) {
          await sleep(retryDelay);
          continue;
        }

        const internalErrorId = logPaymentFailure({
          provider: "PAYHERO",
          operation: options.operation,
          requestReference: options.requestReference,
          responseCode: response.status,
          safeMessage: providerCode ? `${safe} [${providerCode}]` : safe,
          error: lastError,
        });

        throw new PayHeroError(code, safe, response.status, asRecord, internalErrorId);
      }

      return payload as T;
    } catch (error) {
      if (error instanceof PayHeroError) {
        /*
          A logged error carries the internal id and is already final: the
          refusal has been reported once, and repeating the request would only
          repeat it. A 4xx that is not a throttle is final for the same reason.
        */
        if (error.internalErrorId || error.code === "PAYMENT_NOT_CONFIGURED") throw error;

        const kind = retryKindFor(error.httpStatus);
        const delay = kind === null ? null : retryDelayMs(kind, attempt);
        if (attempt >= attempts || delay === null) throw error;

        await sleep(delay);
        continue;
      }

      const aborted = error instanceof Error && error.name === "AbortError";
      lastError = error;

      /*
        A dropped socket or an aborted request is on the SHORT schedule: neither
        is a rate limiter, and waiting seconds for one would only add delay to an
        outage that is already failing faster than the customer wants.
      */
      const transportDelay = retryDelayMs("transient", attempt);
      if (attempt < attempts && transportDelay !== null) {
        await sleep(transportDelay);
        continue;
      }

      const internalErrorId = logPaymentFailure({
        provider: "PAYHERO",
        operation: options.operation,
        requestReference: options.requestReference,
        safeMessage: aborted ? "Provider request timed out" : "Provider request failed",
        error,
      });

      throw new PayHeroError(
        aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNREACHABLE",
        aborted
          ? "The payment provider did not respond in time."
          : "The payment provider could not be reached.",
        null,
        null,
        internalErrorId,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof PayHeroError
    ? lastError
    : new PayHeroError("PROVIDER_UNREACHABLE", "The payment provider could not be reached.");
}

// The payload readers are provider-agnostic, so they live in
// `@/lib/payments/parse` and are re-exported here for a single import site.
export { pickString, pickNumber, pickBoolean, providerSaysOk, providerErrorMessage } from "@/lib/payments/parse";
