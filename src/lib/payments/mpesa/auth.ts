import { logger } from "@/lib/logger";
import { darajaRequest, MpesaError } from "@/lib/payments/mpesa/client";
import { collectionConfig } from "@/lib/payments/mpesa/config";
import type { DarajaTokenResponse } from "@/lib/payments/mpesa/types";

/**
 * Daraja OAuth.
 *
 * `GET /oauth/v1/generate?grant_type=client_credentials` with HTTP Basic
 * authentication. Tokens last about an hour and are cached in module memory
 * until shortly before they expire, so each warm serverless instance
 * authenticates at most once an hour. Concurrent callers share the in-flight
 * request instead of stampeding the token endpoint — Daraja rate-limits it, and
 * a 429 there would take the whole payment path down.
 *
 * This is the only call that is safe to retry: it has no side effect beyond
 * issuing a token.
 */

type CachedToken = { token: string; expiresAt: number; environment: string };

let cachedToken: CachedToken | null = null;
let inflight: Promise<CachedToken> | null = null;

const EXPIRY_SAFETY_MARGIN_MS = 60_000;

function basicAuth(): string {
  const { consumerKey, consumerSecret } = collectionConfig();
  // Daraja wants Basic auth on the token endpoint. The value is constructed per
  // request and never stored or logged.
  return `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}`;
}

function extractToken(payload: DarajaTokenResponse): { token: string; expiresIn: number } {
  const token = payload.access_token;
  if (!token || typeof token !== "string") {
    throw new MpesaError(
      "PROVIDER_AUTH_FAILED",
      "Safaricom did not return an access token.",
      null,
      payload as unknown as Record<string, unknown>,
    );
  }
  // `expires_in` comes back as a string ("3599") despite the docs.
  const expiresIn = Number(payload.expires_in ?? 3599);
  return { token, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3599 };
}

export async function getAccessToken(force = false): Promise<string> {
  const { environment } = (() => {
    try {
      return { environment: process.env.MPESA_ENV?.trim() || "sandbox" };
    } catch {
      return { environment: "sandbox" };
    }
  })();

  if (!force && cachedToken && cachedToken.environment === environment) {
    if (cachedToken.expiresAt - EXPIRY_SAFETY_MARGIN_MS > Date.now()) {
      return cachedToken.token;
    }
  }

  if (inflight && !force) return (await inflight).token;

  const run = async (): Promise<CachedToken> => {
    const payload = await darajaRequest<DarajaTokenResponse>(
      "/oauth/v1/generate?grant_type=client_credentials",
      {
        method: "GET",
        operation: "auth.token",
        retryable: true,
        headers: { Authorization: basicAuth() },
      },
    );

    const { token, expiresIn } = extractToken(payload);
    const next: CachedToken = { token, expiresAt: Date.now() + expiresIn * 1000, environment };
    cachedToken = next;
    logger.info("mpesa_token_acquired", { environment, expiresIn });
    return next;
  };

  inflight = run();
  try {
    return (await inflight).token;
  } finally {
    inflight = null;
  }
}

/** Drops the cached token so the next call re-authenticates. */
export function invalidateAccessToken() {
  cachedToken = null;
}
