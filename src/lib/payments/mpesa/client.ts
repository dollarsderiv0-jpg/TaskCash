import { logger, logPaymentFailure } from "@/lib/logger";
import { sleep } from "@/lib/utils";
import { resolveBaseUrl, mpesaTimeoutMs } from "@/lib/payments/mpesa/config";
import { MpesaError, PaymentConfigurationError } from "@/lib/payments/mpesa/errors";

/**
 * Low-level Daraja HTTP transport.
 *
 * Fail-safe behaviour that matters for a real-money product:
 *  - If credentials are absent we THROW. We never fabricate a successful
 *    payment, and there is no simulator on the M-Pesa side at all. Daraja
 *    itself rejects `OriginatorConversationID` replays, so the idempotency
 *    story is the provider's, not ours.
 *  - Only GET-like, side-effect-free calls are retried. A retried STK Push
 *    sends the customer a second prompt; a retried B2C pays them twice. Both
 *    are single-attempt by construction (`retryable` defaults to false).
 *  - Every failure is logged with a safe summary and a correlation id. Never a
 *    credential, never a full payload containing one.
 */

export { MpesaError, PaymentConfigurationError };

type FetchOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  accessToken?: string;
  /**
   * Whether a retry is safe. Defaults to FALSE, because the two calls that
   * matter here both have a side effect the customer can see.
   */
  retryable?: boolean;
  operation: string;
  requestReference?: string | null;
  /** Extra headers (used by the OAuth call, which authenticates with Basic). */
  headers?: Record<string, string>;
};

const MAX_ATTEMPTS = 3;

export async function darajaRequest<T>(path: string, options: FetchOptions): Promise<T> {
  const { baseUrl } = resolveBaseUrl();
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const timeout = mpesaTimeoutMs();
  const attempts = options.retryable ? MAX_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: options.method ?? "POST",
        headers: {
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
          ...options.headers,
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
        // Daraja sometimes answers with HTML when the endpoint is wrong (e.g.
        // the B2C v1 path, which no longer exists). Keep a short excerpt so the
        // cause is visible without storing a whole page.
        payload = { raw: text.slice(0, 500) };
      }

      const record = (payload ?? {}) as Record<string, unknown>;

      if (!response.ok) {
        const safe =
          typeof record.errorMessage === "string"
            ? record.errorMessage
            : typeof record.error_description === "string"
              ? record.error_description
              : `Provider responded with HTTP ${response.status}`;

        // A 4xx will not fix itself on retry; 5xx and 429 are worth one.
        const transient = response.status >= 500 || response.status === 429;

        if (transient && attempt < attempts) {
          await sleep(400 * 2 ** (attempt - 1));
          continue;
        }

        const internalErrorId = logPaymentFailure({
          provider: "MPESA",
          operation: options.operation,
          requestReference: options.requestReference,
          responseCode: response.status,
          safeMessage: safe,
          error: new MpesaError("PROVIDER_HTTP_ERROR", safe, response.status, record),
        });

        throw new MpesaError(
          "PROVIDER_HTTP_ERROR",
          safe,
          response.status,
          record,
          internalErrorId,
        );
      }

      // Daraja reports application-level failures with HTTP 200 and a non-zero
      // errorCode, so a 2xx is not by itself a success.
      if (typeof record.errorCode === "string" && record.errorCode.trim() !== "") {
        const safe =
          typeof record.errorMessage === "string"
            ? record.errorMessage
            : `Provider rejected the request (${record.errorCode}).`;

        const internalErrorId = logPaymentFailure({
          provider: "MPESA",
          operation: options.operation,
          requestReference: options.requestReference,
          responseCode: record.errorCode,
          safeMessage: safe,
          error: new MpesaError("PROVIDER_REJECTED", safe, response.status, record),
        });

        throw new MpesaError(
          "PROVIDER_REJECTED",
          safe,
          response.status,
          record,
          internalErrorId,
        );
      }

      return payload as T;
    } catch (error) {
      if (error instanceof MpesaError) throw error;

      const aborted = error instanceof Error && error.name === "AbortError";

      if (attempt < attempts) {
        await sleep(400 * 2 ** (attempt - 1));
        continue;
      }

      const internalErrorId = logPaymentFailure({
        provider: "MPESA",
        operation: options.operation,
        requestReference: options.requestReference,
        safeMessage: aborted ? "Provider request timed out" : "Provider request failed",
        error,
      });

      logger.error("mpesa_request_failed", {
        operation: options.operation,
        aborted,
        internalErrorId,
      });

      throw new MpesaError(
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

  throw new MpesaError("PROVIDER_UNREACHABLE", "The payment provider could not be reached.");
}
