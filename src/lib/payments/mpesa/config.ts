import {
  isProduction,
  missingMpesaCollectionEnv,
  missingMpesaPayoutEnv,
  hasMpesaCollectionCredentials,
  hasMpesaPayoutCredentials,
  mpesaEnvironment,
} from "@/lib/env";
import { PaymentConfigurationError } from "@/lib/payments/mpesa/errors";

/**
 * Daraja configuration, read from the server environment at call time.
 *
 * Two sets of credentials, checked separately on purpose:
 *
 *   collection — everything an STK Push needs. Without these, a user cannot
 *                deposit, but payouts may still be configurable.
 *   payout     — additionally needs the B2C initiator and its encrypted
 *                security credential.
 *
 * Keeping them apart is what stops "we cannot take money in" from being
 * reported as "we cannot send money out" — a distinction that matters when an
 * administrator is deciding whether to approve a withdrawal.
 */

const DEFAULT_TIMEOUT_MS = 20_000;

export type MpesaEnvironment = "sandbox" | "production";

export type MpesaCollectionConfig = {
  consumerKey: string;
  consumerSecret: string;
  shortCode: string;
  passKey: string;
  /** Where Safaricom POSTs the STK result. Must be HTTPS in production. */
  callbackUrl: string;
  /** CustomerPayBillOnline for a paybill, CustomerBuyGoodsOnline for a till. */
  transactionType: "CustomerPayBillOnline" | "CustomerBuyGoodsOnline";
};

export type MpesaPayoutConfig = {
  initiatorName: string;
  securityCredential: string;
  shortCode: string;
  resultUrl: string;
  queueTimeoutUrl: string;
  commandId: "BusinessPayment" | "SalaryPayment" | "PromotionPayment";
};

// The credential sets live in `@/lib/env` (the single authority on what is
// configured) and are re-exported here so callers can import one module.
export {
  missingMpesaCollectionEnv,
  missingMpesaPayoutEnv,
  hasMpesaCollectionCredentials,
  hasMpesaPayoutCredentials,
  mpesaEnvironment,
};

/**
 * Daraja's two hosts — the only two that exist. Nothing may override these.
 */
export const DARAJA_HOSTS: Record<MpesaEnvironment, string> = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke",
};

/**
 * Daraja's base URL. Derived from MPESA_ENV rather than taken as a free-text
 * variable, so it is impossible to typo the hostname into something that does
 * not exist, and refused outright if a sandbox host would be used in a
 * production build with real credentials.
 *
 * `MPESA_BASE_URL` IS accepted, because configuration templates and hosting
 * dashboards routinely carry it — but only as an *assertion*, never as free
 * text. It must name one of the two official hosts, and it must agree with
 * MPESA_ENV. Anything else is refused loudly rather than ignored.
 *
 * Why refuse instead of ignore: a deployment that sets
 * `MPESA_BASE_URL=https://api.safaricom.co.ke` while MPESA_ENV still says
 * `sandbox` *believes* it is taking live money and is not. Silently preferring
 * one of the two turns a ten-second fix into a support investigation. And a
 * host outside the allowlist is worse than a mistake — it is where the Consumer
 * Secret would be sent.
 */
export function resolveBaseUrl(): { baseUrl: string; environment: MpesaEnvironment } {
  const environment = mpesaEnvironment();
  const expected = DARAJA_HOSTS[environment];

  // Trailing slashes are harmless in every real configuration template.
  const override = process.env.MPESA_BASE_URL?.trim().replace(/\/+$/, "");

  if (override) {
    const official = Object.values(DARAJA_HOSTS);

    if (!official.includes(override)) {
      throw new PaymentConfigurationError([
        "MPESA_BASE_URL(=not a Safaricom host)",
        `MPESA_BASE_URL may only be ${DARAJA_HOSTS.sandbox} or ${DARAJA_HOSTS.production}. ` +
          "Daraja endpoints are fixed; any other host is where the Consumer Secret would be sent.",
      ]);
    }

    if (override !== expected) {
      throw new PaymentConfigurationError([
        "MPESA_BASE_URL(=disagrees with MPESA_ENV)",
        `MPESA_ENV is "${environment}", which means ${expected}, but MPESA_BASE_URL is "${override}". ` +
          `Set MPESA_ENV=${override === DARAJA_HOSTS.production ? "production" : "sandbox"}, ` +
          "or remove MPESA_BASE_URL and let MPESA_ENV decide.",
      ]);
    }
  }

  if (isProduction() && environment !== "production") {
    throw new PaymentConfigurationError(
      [
        "MPESA_ENV(=production)",
        `MPESA_ENV is "${environment}" while the application is running in production. Refusing to ` +
          "call the sandbox host from a production build.",
      ],
    );
  }

  return { baseUrl: expected, environment };
}

export function mpesaTimeoutMs(): number {
  const raw = Number(process.env.MPESA_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Everything an STK Push needs. Throws when any piece is missing — the caller
 * must then report "not configured" rather than attempting a payment.
 */
export function collectionConfig(): MpesaCollectionConfig {
  const missing = missingMpesaCollectionEnv();
  if (missing.length > 0) throw new PaymentConfigurationError(missing);

  const callbackUrl = process.env.MPESA_CALLBACK_URL!.trim();
  assertHttps(callbackUrl, "MPESA_CALLBACK_URL");

  const rawType = process.env.MPESA_TRANSACTION_TYPE?.trim();
  const transactionType =
    rawType === "CustomerBuyGoodsOnline" ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline";

  return {
    consumerKey: process.env.MPESA_CONSUMER_KEY!.trim(),
    consumerSecret: process.env.MPESA_CONSUMER_SECRET!.trim(),
    shortCode: process.env.MPESA_SHORTCODE!.trim(),
    passKey: process.env.MPESA_PASSKEY!.trim(),
    callbackUrl,
    transactionType,
  };
}

/** Everything a B2C payout needs, on top of the collection set. */
export function payoutConfig(): MpesaPayoutConfig {
  const missing = missingMpesaPayoutEnv();
  if (missing.length > 0) throw new PaymentConfigurationError(missing);

  const resultUrl = process.env.MPESA_B2C_RESULT_URL!.trim();
  const queueTimeoutUrl = process.env.MPESA_B2C_QUEUE_TIMEOUT_URL!.trim();
  assertHttps(resultUrl, "MPESA_B2C_RESULT_URL");
  assertHttps(queueTimeoutUrl, "MPESA_B2C_QUEUE_TIMEOUT_URL");

  const rawCommand = process.env.MPESA_B2C_COMMAND_ID?.trim();
  const commandId =
    rawCommand === "SalaryPayment" || rawCommand === "PromotionPayment"
      ? rawCommand
      : "BusinessPayment";

  return {
    initiatorName: process.env.MPESA_B2C_INITIATOR_NAME!.trim(),
    securityCredential: process.env.MPESA_B2C_SECURITY_CREDENTIAL!.trim(),
    shortCode: (process.env.MPESA_B2C_SHORTCODE ?? process.env.MPESA_SHORTCODE)!.trim(),
    resultUrl,
    queueTimeoutUrl,
    commandId,
  };
}

/**
 * Safaricom will not POST to a plain-HTTP URL, and neither will we accept a
 * localhost callback address in a production build: it would mean every
 * callback is silently lost, which looks exactly like "the customer never paid".
 */
function assertHttps(url: string, variable: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PaymentConfigurationError([`${variable}(=malformed URL)`]);
  }

  if (parsed.protocol !== "https:") {
    throw new PaymentConfigurationError([
      `${variable}(=must be https)`,
      `${variable} must be an https URL — Safaricom does not call back over http.`,
    ]);
  }

  if (isProduction() && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname)) {
    throw new PaymentConfigurationError([
      `${variable}(=localhost)`,
      `${variable} points at localhost, which Safaricom cannot reach.`,
    ]);
  }
}

/** Safe summary for logs, health checks and the admin screen. Values omitted. */
export function mpesaConfigStatus() {
  let environment = mpesaEnvironment();
  let configurationError: string | null = null;

  try {
    environment = resolveBaseUrl().environment;
  } catch (error) {
    /*
      resolveBaseUrl() is the one part of this configuration that can be *wrong*
      rather than merely *absent*, and when it is, every deposit and payout is
      refused. Swallowing that here would leave the health endpoint reporting a
      perfectly healthy-looking host while payments could never work — a status
      that actively misleads. So the failure is surfaced instead.

      Only the variable NAME is reported, never its value.
    */
    configurationError =
      error instanceof PaymentConfigurationError
        ? (error.variables[0]?.split("(")[0] ?? "MPESA_CONFIGURATION")
        : "MPESA_CONFIGURATION";
    environment = mpesaEnvironment();
  }

  return {
    environment,
    // Which host money would actually be sent to. A URL, not a credential, so
    // it is safe on the health endpoint and the admin screen — and it is the
    // single most useful field when "the payment went to the wrong place".
    baseUrl: DARAJA_HOSTS[environment],
    // Non-null when the host configuration itself is invalid. The application
    // will refuse to take or send money until it is fixed.
    configurationError,
    collectionConfigured: hasMpesaCollectionCredentials(),
    payoutConfigured: hasMpesaPayoutCredentials(),
    missingCollection: missingMpesaCollectionEnv(),
    missingPayout: missingMpesaPayoutEnv(),
  };
}
