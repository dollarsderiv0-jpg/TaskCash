import {
  getServerEnv,
  hasPaymentCredentials,
  isPaymentSimulatorEnabled,
  missingPaymentEnv,
  isProduction,
} from "@/lib/env";
import { logPaymentFailure, logger } from "@/lib/logger";
import { sleep } from "@/lib/utils";

/**
 * Low-level SasaPay HTTP transport.
 *
 * Fail-safe behaviour that matters for a real-money product:
 *  - If credentials are absent in production we THROW. We never fabricate a
 *    successful payment. There is no in-memory "mock balance" anywhere.
 *  - The only way to get simulated provider responses is to opt in with
 *    SASAPAY_SIMULATOR=1 outside production; the simulator is loud, is
 *    recorded on the record as SIMULATED, and cannot run in production.
 */

export class SasaPayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number | null = null,
    public readonly providerPayload: Record<string, unknown> | null = null,
    public readonly internalErrorId: string | null = null,
  ) {
    super(message);
    this.name = "SasaPayError";
  }
}

export class PaymentConfigurationError extends SasaPayError {
  constructor(missing: string[]) {
    super(
      "PAYMENT_NOT_CONFIGURED",
      `Payment provider is not configured. Missing: ${missing.join(", ") || "credentials"}. ` +
        "Payments are disabled until these environment variables are set.",
    );
    this.name = "PaymentConfigurationError";
  }
}

export type ApiBase = { baseUrl: string; environment: "sandbox" | "production"; simulated: boolean };

export function resolveApiBase(): ApiBase {
  const explicit = process.env.SASAPAY_API_URL?.trim();

  if (!hasPaymentCredentials()) {
    if (isPaymentSimulatorEnabled()) {
      return { baseUrl: "local://simulator", environment: "sandbox", simulated: true };
    }
    throw new PaymentConfigurationError(missingPaymentEnv());
  }

  const env = getServerEnv();
  const fallback =
    env.sasapayEnv === "production"
      ? "https://api.sasapay.app/api/v1"
      : "https://sandbox.sasapay.app/api/v1";

  // The merchant's own dashboard is the source of truth for the base URL, so
  // SASAPAY_API_URL always wins when present.
  const baseUrl = (explicit && explicit.length > 0 ? explicit : fallback).replace(/\/+$/, "");

  if (isProduction() && baseUrl.includes("sandbox")) {
    logger.error("sasapay_sandbox_url_in_production", { baseUrl });
    throw new SasaPayError(
      "PAYMENT_MISCONFIGURED",
      "Refusing to use a SasaPay sandbox endpoint in production. Set SASAPAY_API_URL to the production endpoint.",
    );
  }

  return { baseUrl, environment: env.sasapayEnv, simulated: false };
}

type FetchOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  accessToken?: string;
  /** Idempotent operations may be retried safely; money-moving ones may not. */
  retryable?: boolean;
  operation: string;
  requestReference?: string | null;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

export async function sasapayRequest<T>(path: string, options: FetchOptions): Promise<T> {
  const base = resolveApiBase();

  if (base.simulated) {
    const { simulateRequest } = await import("@/lib/payments/sasapay/simulator");
    return simulateRequest<T>(path, options);
  }

  const url = `${base.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const timeout = Number(process.env.SASAPAY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const attempts = options.retryable ? MAX_ATTEMPTS : 1;

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: options.method ?? "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
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
        const safe =
          (payload as { detail?: string; message?: string; errorMessage?: string } | null)?.detail ??
          (payload as { message?: string } | null)?.message ??
          (payload as { errorMessage?: string } | null)?.errorMessage ??
          `Provider responded with HTTP ${response.status}`;

        // 5xx and 429 are worth a bounded retry; a 4xx will not fix itself.
        const transient = response.status >= 500 || response.status === 429;
        lastError = new SasaPayError(
          "PROVIDER_HTTP_ERROR",
          safe,
          response.status,
          payload as Record<string, unknown> | null,
        );

        if (transient && attempt < attempts) {
          await sleep(400 * 2 ** (attempt - 1));
          continue;
        }

        const internalErrorId = logPaymentFailure({
          provider: "SASAPAY",
          operation: options.operation,
          requestReference: options.requestReference,
          responseCode: response.status,
          safeMessage: safe,
          error: lastError,
        });
        throw new SasaPayError(
          "PROVIDER_HTTP_ERROR",
          safe,
          response.status,
          payload as Record<string, unknown> | null,
          internalErrorId,
        );
      }

      return payload as T;
    } catch (error) {
      if (error instanceof SasaPayError) throw error;

      const aborted = error instanceof Error && error.name === "AbortError";
      lastError = error;

      if (attempt < attempts) {
        await sleep(400 * 2 ** (attempt - 1));
        continue;
      }

      const internalErrorId = logPaymentFailure({
        provider: "SASAPAY",
        operation: options.operation,
        requestReference: options.requestReference,
        safeMessage: aborted ? "Provider request timed out" : "Provider request failed",
        error,
      });

      throw new SasaPayError(
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

  throw new SasaPayError("PROVIDER_UNREACHABLE", "The payment provider could not be reached.");
}

// The payload readers are provider-agnostic, so they live in
// `@/lib/payments/parse` and are re-exported here for the existing imports.
export { providerSaysOk, pickString, pickNumber } from "@/lib/payments/parse";
