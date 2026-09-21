import { getServerEnv, hasPaymentCredentials, isPaymentSimulatorEnabled } from "@/lib/env";
import { logger } from "@/lib/logger";
import { sasapayRequest, SasaPayError, type ApiBase } from "@/lib/payments/sasapay/client";
import { resolveApiBase } from "@/lib/payments/sasapay/client";
import type { TokenResponse } from "@/lib/payments/sasapay/types";

/**
 * SasaPay OAuth.
 *
 * Tokens are cached in module memory until shortly before expiry. Each warm
 * serverless instance therefore authenticates at most once per token lifetime,
 * which keeps us comfortably inside provider rate limits. Concurrent callers
 * share the in-flight request instead of stampeding the token endpoint.
 */

type CachedToken = { token: string; expiresAt: number; baseUrl: string };

let cachedToken: CachedToken | null = null;
let inflight: Promise<CachedToken> | null = null;

const EXPIRY_SAFETY_MARGIN_MS = 60_000;

function credentials(): { clientId: string; clientSecret: string } {
  const env = getServerEnv();
  if (!env.SASAPAY_CLIENT_ID || !env.SASAPAY_CLIENT_SECRET) {
    throw new SasaPayError(
      "PAYMENT_NOT_CONFIGURED",
      "SasaPay client credentials are not configured.",
    );
  }
  return { clientId: env.SASAPAY_CLIENT_ID, clientSecret: env.SASAPAY_CLIENT_SECRET };
}

function extractToken(payload: TokenResponse): { token: string; expiresIn: number } {
  // The provider has returned tokens both nested under auth_details and flat.
  const token =
    payload.access_token ??
    payload.auth_details?.access_token ??
    null;
  const expiresIn = payload.expires_in ?? payload.auth_details?.expires_in ?? 3599;

  if (!token || typeof token !== "string") {
    throw new SasaPayError(
      "PROVIDER_AUTH_FAILED",
      "SasaPay did not return an access token.",
      null,
      payload as unknown as Record<string, unknown>,
    );
  }

  return { token, expiresIn: Number(expiresIn) || 3599 };
}

export async function getAccessToken(force = false): Promise<string> {
  const base: ApiBase = resolveApiBase();

  if (base.simulated) return "simulator-token";

  if (!force && cachedToken && cachedToken.baseUrl === base.baseUrl) {
    if (cachedToken.expiresAt - EXPIRY_SAFETY_MARGIN_MS > Date.now()) {
      return cachedToken.token;
    }
  }

  if (inflight && !force) return (await inflight).token;

  const run = async (): Promise<CachedToken> => {
    const { clientId, clientSecret } = credentials();

    const payload = await sasapayRequest<TokenResponse>("/auth/token/", {
      method: "POST",
      operation: "auth.token",
      retryable: true,
      body: {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      },
    });

    const { token, expiresIn } = extractToken(payload);
    const next: CachedToken = {
      token,
      expiresAt: Date.now() + expiresIn * 1000,
      baseUrl: base.baseUrl,
    };
    cachedToken = next;
    logger.info("sasapay_token_acquired", { environment: base.environment, expiresIn });
    return next;
  };

  inflight = run();
  try {
    const result = await inflight;
    return result.token;
  } finally {
    inflight = null;
  }
}

/** Drops the cached token so the next call re-authenticates. */
export function invalidateAccessToken() {
  cachedToken = null;
}

export function paymentProviderStatus() {
  return {
    configured: hasPaymentCredentials(),
    simulator: isPaymentSimulatorEnabled(),
    environment: hasPaymentCredentials() ? resolveApiBase().environment : "unconfigured",
  };
}
