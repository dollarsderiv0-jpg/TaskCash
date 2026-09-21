import { logPaymentFailure } from "@/lib/logger";
import { sleep } from "@/lib/utils";
import {
  payheroCredentials,
  payheroTimeoutMs,
  resolveApiBase,
} from "@/lib/payments/payhero/config";
import { PayHeroError } from "@/lib/payments/payhero/errors";

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

const MAX_ATTEMPTS = 3;

export async function payheroRequest<T>(path: string, options: FetchOptions): Promise<T> {
  const base = resolveApiBase();
  const url = `${base.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  const timeout = payheroTimeoutMs();
  const attempts = options.retryable ? MAX_ATTEMPTS : 1;
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
        const safe =
          (typeof asRecord?.detail === "string" && asRecord.detail) ||
          (typeof asRecord?.error === "string" && asRecord.error) ||
          (typeof asRecord?.errorMessage === "string" && asRecord.errorMessage) ||
          (typeof asRecord?.message === "string" && asRecord.message) ||
          `PayHero responded with HTTP ${response.status}`;

        // 5xx and 429 will not fix themselves within one request, but they are
        // worth a bounded retry; a 4xx will not fix itself at all.
        const transient = response.status >= 500 || response.status === 429;

        lastError = new PayHeroError(
          "PROVIDER_HTTP_ERROR",
          safe,
          response.status,
          asRecord,
        );

        if (transient && attempt < attempts) {
          await sleep(400 * 2 ** (attempt - 1));
          continue;
        }

        const internalErrorId = logPaymentFailure({
          provider: "PAYHERO",
          operation: options.operation,
          requestReference: options.requestReference,
          responseCode: response.status,
          safeMessage: safe,
          error: lastError,
        });

        throw new PayHeroError("PROVIDER_HTTP_ERROR", safe, response.status, asRecord, internalErrorId);
      }

      return payload as T;
    } catch (error) {
      if (error instanceof PayHeroError) {
        // A 4xx is final: retrying it would only repeat the same refusal.
        if (error.internalErrorId || error.code === "PAYMENT_NOT_CONFIGURED") throw error;
        if (attempt >= attempts) throw error;
        await sleep(400 * 2 ** (attempt - 1));
        continue;
      }

      const aborted = error instanceof Error && error.name === "AbortError";
      lastError = error;

      if (attempt < attempts) {
        await sleep(400 * 2 ** (attempt - 1));
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
