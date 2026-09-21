import {
  hasPayheroCollectionCredentials,
  hasPayheroPayoutCredentials,
  isProduction,
  missingPayheroCollectionEnv,
  missingPayheroPayoutEnv,
  payheroChannelId,
} from "@/lib/env";
import { PaymentConfigurationError } from "@/lib/payments/payhero/errors";

/**
 * PayHero configuration, read from the server environment at call time.
 *
 * Credentials are an API **username and password** issued in the PayHero
 * dashboard (https://app.payhero.co.ke) and sent as HTTP Basic auth on every
 * request. PayHero has no OAuth token endpoint, so there is nothing to refresh
 * and nothing to cache.
 *
 * The host is validated rather than merely read. PayHero authenticates with a
 * *password*, so a typo'd or attacker-supplied base URL is not a failed request
 * — it is the place that password gets sent. Only PayHero's own hosts are
 * accepted.
 */

/** PayHero's documented host. One host serves both live and test channels. */
export const PAYHERO_DEFAULT_BASE_URL = "https://backend.payhero.co.ke/api/v2";

const DEFAULT_TIMEOUT_MS = 20_000;

/** Hostnames the API password may be sent to. */
function isPayheroHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "payhero.co.ke" || host.endsWith(".payhero.co.ke");
}

export type PayheroApiBase = {
  baseUrl: string;
  /** Always false: PayHero has no simulator, and we never fabricate one. */
  simulated: false;
};

export function resolveApiBase(): PayheroApiBase {
  const raw = (process.env.PAYHERO_API_URL?.trim() || PAYHERO_DEFAULT_BASE_URL).replace(/\/+$/, "");

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PaymentConfigurationError(["PAYHERO_API_URL(=malformed URL)"]);
  }

  if (parsed.protocol !== "https:") {
    throw new PaymentConfigurationError([
      "PAYHERO_API_URL(=must be https)",
      "PAYHERO_API_URL must be https — the PayHero API password is sent as Basic auth on every request.",
    ]);
  }

  if (!isPayheroHost(parsed.hostname)) {
    throw new PaymentConfigurationError([
      "PAYHERO_API_URL(=not a PayHero host)",
      `PAYHERO_API_URL points at "${parsed.hostname}", which is not a payhero.co.ke host. ` +
        "Refusing to send the PayHero API password anywhere else.",
    ]);
  }

  if (isProduction() && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname)) {
    throw new PaymentConfigurationError(["PAYHERO_API_URL(=localhost)"]);
  }

  return { baseUrl: raw, simulated: false };
}

export function payheroTimeoutMs(): number {
  const raw = Number(process.env.PAYHERO_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export function payheroCredentials(): { username: string; password: string } {
  const missing = missingPayheroCollectionEnv();
  if (missing.length > 0) throw new PaymentConfigurationError(missing);

  return {
    username: process.env.PAYHERO_API_USERNAME!.trim(),
    password: process.env.PAYHERO_API_PASSWORD!.trim(),
  };
}

/**
 * Where PayHero posts the result of a payment.
 *
 * Must be reachable from the public internet: a callback URL pointing at
 * localhost means every payment silently never settles, which looks exactly
 * like "the customer never paid".
 */
export function defaultCallbackUrl(): string {
  const env = process.env.PAYHERO_CALLBACK_URL?.trim();
  if (env) return env;

  const appUrl = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  return `${appUrl}/api/payments/payhero/callback`;
}

export type PayheroCollectionConfig = {
  channelId: number;
  callbackUrl: string;
};

/** Everything an STK push needs. Throws when any piece is missing. */
export function collectionConfig(): PayheroCollectionConfig {
  const missing = missingPayheroCollectionEnv();
  if (missing.length > 0) throw new PaymentConfigurationError(missing);

  const channelId = payheroChannelId();
  if (channelId === null) {
    throw new PaymentConfigurationError(["PAYHERO_CHANNEL_ID(=not a number)"]);
  }

  const callbackUrl = defaultCallbackUrl();
  assertUsableCallback(callbackUrl, process.env.PAYHERO_CALLBACK_URL ? "PAYHERO_CALLBACK_URL" : "APP_URL");

  return { channelId, callbackUrl };
}

export type PayheroPayoutConfig = {
  callbackUrl: string;
  /** SasaPay network code for the recipient's telco. */
  defaultNetworkCode: string;
};

/** Everything a payout needs, on top of the collection set. */
export function payoutConfig(): PayheroPayoutConfig {
  const missing = missingPayheroPayoutEnv();
  if (missing.length > 0) throw new PaymentConfigurationError(missing);

  const callbackUrl = defaultCallbackUrl();
  assertUsableCallback(callbackUrl, process.env.PAYHERO_CALLBACK_URL ? "PAYHERO_CALLBACK_URL" : "APP_URL");

  return {
    callbackUrl,
    defaultNetworkCode: process.env.PAYHERO_DEFAULT_NETWORK_CODE?.trim() || "SASAFA",
  };
}

function assertUsableCallback(url: string, variable: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PaymentConfigurationError([`${variable}(=malformed URL)`]);
  }

  if (parsed.protocol !== "https:") {
    throw new PaymentConfigurationError([
      `${variable}(=must be https)`,
      "PayHero cannot deliver a callback over http, so the payment would never settle.",
    ]);
  }

  if (isProduction() && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname)) {
    throw new PaymentConfigurationError([
      `${variable}(=localhost)`,
      "The callback URL points at localhost, which PayHero cannot reach.",
    ]);
  }
}

/**
 * Safe summary for logs, the health endpoint and the admin screen. Variable
 * NAMES and a host URL only — never a credential value.
 */
export function payheroConfigStatus() {
  let baseUrl = PAYHERO_DEFAULT_BASE_URL;
  let configurationError: string | null = null;

  try {
    baseUrl = resolveApiBase().baseUrl;
  } catch (error) {
    /*
      The host is the one part of this configuration that can be *wrong* rather
      than merely absent, and when it is, every payment is refused. Reporting a
      healthy-looking configuration here would actively mislead a monitor.
      Only the variable NAME is surfaced, never its value.
    */
    configurationError =
      error instanceof PaymentConfigurationError
        ? (error.variables[0]?.split("(")[0] ?? "PAYHERO_CONFIGURATION")
        : "PAYHERO_CONFIGURATION";
  }

  return {
    baseUrl,
    configurationError,
    collectionConfigured: hasPayheroCollectionCredentials(),
    payoutConfigured: hasPayheroPayoutCredentials(),
    missingCollection: missingPayheroCollectionEnv(),
    missingPayout: missingPayheroPayoutEnv(),
  };
}
