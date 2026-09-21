import {
  activePaymentProvider,
  hasPaymentCredentials,
  isPaymentSimulatorEnabled,
  missingPaymentEnv,
  missingProviderEnv,
  providerConfigured,
} from "@/lib/env";
import { MpesaError } from "@/lib/payments/mpesa/errors";
import {
  disburseToCustomer as mpesaDisburse,
  initiateStkPush,
  mpesaConfigStatus,
  mpesaPayoutReadiness,
  verifyCollection as mpesaVerifyCollection,
  verifyDisbursement as mpesaVerifyDisbursement,
} from "@/lib/payments/mpesa";
import {
  disburseToCustomer as payheroDisburse,
  initiateCollection as payheroCollect,
  payoutReadiness as payheroPayoutReadiness,
  payheroConfigStatus,
  verifyCollection as payheroVerifyCollection,
  verifyDisbursement as payheroVerifyDisbursement,
} from "@/lib/payments/payhero";
import { PayHeroError } from "@/lib/payments/payhero/errors";
import { initiateCollection as sasapayCollect } from "@/lib/payments/sasapay/collect";
import { disburseToCustomer as sasapayDisburse } from "@/lib/payments/sasapay/disburse";
import { verifyCollection as sasapayVerifyCollection, verifyDisbursement as sasapayVerifyDisbursement } from "@/lib/payments/sasapay/verify";
import { payoutReadiness as sasapayPayoutReadiness } from "@/lib/payments/sasapay/readiness";
import type {
  PaymentProviderId,
  PayoutReadiness,
  ProviderResult,
} from "@/lib/payments/types";
import type { VerificationVerdict } from "@/lib/payments/verify-types";

/**
 * The payment provider facade.
 *
 * Every money path in the application calls this module, never a provider
 * directly. That is what makes "use M-Pesa instead of SasaPay" a configuration
 * change (`PAYMENTS_PROVIDER`) rather than an edit to the deposit and
 * withdrawal services — and what keeps the settlement, idempotency and audit
 * behaviour identical whichever provider is selected.
 *
 * `SASAPAY` is retained (not deleted) because its implementation is complete
 * and working; switching back is legitimate, and removing it would also remove
 * the simulator that local development depends on.
 */

export type CollectInput = {
  merchantReference: string;
  /** Recipient number. E.164 (`+254…`) is accepted and normalised per provider. */
  phone: string;
  amount: number;
  currency: string;
  description: string;
  /** SasaPay only; ignored by M-Pesa. */
  networkCode?: string | null;
  callbackUrl?: string;
};

export type DisburseInput = {
  merchantReference: string;
  phone: string;
  amount: number;
  currency: string;
  description: string;
  /** SasaPay only; ignored by M-Pesa. */
  channelCode?: string;
};

export function paymentProviderId(): PaymentProviderId {
  const provider = activePaymentProvider();
  if (provider === "sasapay") return "SASAPAY";
  if (provider === "payhero") return "PAYHERO";
  return "MPESA";
}

/** Human-readable name for operator-facing copy. Never for end users. */
export function paymentProviderLabel(): string {
  const id = paymentProviderId();
  if (id === "MPESA") return "M-Pesa";
  if (id === "PAYHERO") return "PayHero";
  return "SasaPay";
}

/**
 * Starts a collection (deposit). `ok: true` means only that the customer has
 * been prompted — never that money arrived.
 */
export async function initiateCollection(input: CollectInput): Promise<ProviderResult> {
  if (paymentProviderId() === "MPESA") {
    if (input.currency !== "KES") {
      throw new MpesaError(
        "CURRENCY_UNSUPPORTED",
        `M-Pesa collects Kenyan shillings only; this deposit is in ${input.currency}.`,
      );
    }
    return initiateStkPush({
      merchantReference: input.merchantReference,
      phone: input.phone,
      amount: input.amount,
      description: input.description,
      callbackUrl: input.callbackUrl,
    });
  }

  if (paymentProviderId() === "PAYHERO") {
    if (input.currency !== "KES") {
      throw new PayHeroError(
        "CURRENCY_UNSUPPORTED",
        `PayHero collects Kenyan shillings only; this deposit is in ${input.currency}.`,
      );
    }
    return payheroCollect({
      merchantReference: input.merchantReference,
      phone: input.phone,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      callbackUrl: input.callbackUrl,
    });
  }

  return sasapayCollect({
    merchantReference: input.merchantReference,
    phone: input.phone,
    amount: input.amount,
    currency: input.currency,
    description: input.description,
    networkCode: input.networkCode ?? "0",
    callbackUrl: input.callbackUrl,
  });
}

/**
 * Sends a payout. Only ever called for an admin-approved withdrawal, and a
 * synchronous success here still does not mark the withdrawal COMPLETED.
 */
export async function disburseToCustomer(input: DisburseInput): Promise<ProviderResult> {
  if (paymentProviderId() === "MPESA") {
    return mpesaDisburse({
      merchantReference: input.merchantReference,
      phone: input.phone,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
    });
  }

  if (paymentProviderId() === "PAYHERO") {
    return payheroDisburse({
      merchantReference: input.merchantReference,
      phone: input.phone,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      // PayHero pays out through SasaPay, so it routes by the recipient's
      // network code. The withdrawal service supplies the SasaPay channel code
      // it already computes; PayHero treats it as the destination network.
      networkCode: input.channelCode ?? null,
    });
  }

  return sasapayDisburse({
    merchantReference: input.merchantReference,
    phone: input.phone,
    amount: input.amount,
    currency: input.currency,
    description: input.description,
    channelCode: input.channelCode ?? "0",
  });
}

export async function verifyCollection(input: {
  checkoutRequestId: string | null;
  expectedAmount: number;
}): Promise<VerificationVerdict> {
  const id = paymentProviderId();
  if (id === "MPESA") return mpesaVerifyCollection(input);
  if (id === "PAYHERO") return payheroVerifyCollection(input);
  return sasapayVerifyCollection(input);
}

export async function verifyDisbursement(input: {
  checkoutRequestId: string | null;
  expectedAmount: number;
}): Promise<VerificationVerdict> {
  const id = paymentProviderId();
  if (id === "MPESA") return mpesaVerifyDisbursement(input);
  if (id === "PAYHERO") return payheroVerifyDisbursement(input);
  return sasapayVerifyDisbursement(input);
}

/**
 * Asked before any payout is attempted. See the provider-specific modules for
 * why a simulator can never make this true.
 */
export function payoutReadiness(): PayoutReadiness {
  const id = paymentProviderId();
  if (id === "MPESA") return mpesaPayoutReadiness();
  if (id === "PAYHERO") return payheroPayoutReadiness();

  const sasapay = sasapayPayoutReadiness();
  return { ...sasapay, provider: "SASAPAY" };
}

/**
 * True when an error is *our* configuration fault rather than the provider's
 * refusal — whichever provider is active.
 *
 * Read structurally by error CODE rather than by `instanceof` a provider's
 * class. Every provider defines its own error type, so an `instanceof
 * MpesaError` check silently stops matching the moment the active provider
 * changes — and the two cases it separates have opposite money outcomes.
 *
 * The stakes are concrete: in the deposit path, mistaking a configuration
 * fault for a provider failure records a charge that never happened; in the
 * withdrawal path it releases the hold and undoes an administrator's approval
 * for a reason unrelated to that withdrawal.
 */
export function isPaymentConfigurationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === "PAYMENT_NOT_CONFIGURED";
}

/** Can collections (deposits) be taken through the active provider? */
export function canCollect(): boolean {
  return providerConfigured("COLLECT");
}

/** Can payouts leave through the active provider? */
export function canPayout(): boolean {
  return providerConfigured("PAYOUT");
}

/** Variable NAMES the active provider is missing. Never values. */
export function missingProviderConfiguration(direction: "COLLECT" | "PAYOUT"): string[] {
  return missingProviderEnv(direction);
}

/**
 * Safe summary for logs, the health endpoint and the admin screen. Counts and
 * environment only — no credential value is ever included.
 */
export function paymentProviderStatus() {
  const id = paymentProviderId();

  if (id === "MPESA") {
    const status = mpesaConfigStatus();
    return {
      provider: id,
      environment: status.environment,
      // Which host money would go to, and the variable at fault when the host
      // configuration is invalid rather than merely absent. A URL and a variable
      // NAME — never a credential value. Both must be passed through here, not
      // merely produced by mpesaConfigStatus(): this is the active provider, so
      // omitting them is exactly the case a monitor would be watching for.
      baseUrl: status.baseUrl,
      configurationError: status.configurationError,
      collectionConfigured: status.collectionConfigured,
      payoutConfigured: status.payoutConfigured,
      missingCollection: status.missingCollection,
      missingPayout: status.missingPayout,
      simulator: false,
    };
  }

  if (id === "PAYHERO") {
    const status = payheroConfigStatus();
    return {
      provider: id,
      // PayHero serves live and test channels from one host, so "environment"
      // reports whether the credentials are usable rather than naming a host
      // that does not exist. The host itself is reported below.
      environment: status.collectionConfigured ? "configured" : "unconfigured",
      baseUrl: status.baseUrl,
      configurationError: status.configurationError,
      collectionConfigured: status.collectionConfigured,
      payoutConfigured: status.payoutConfigured,
      missingCollection: status.missingCollection,
      missingPayout: status.missingPayout,
      // There is no PayHero simulator and no code path that fabricates a
      // provider response, so this is always false. It is reported explicitly
      // rather than omitted so a monitor can assert on it.
      simulator: false,
    };
  }

  return {
    provider: id,
    environment: hasPaymentCredentials() ? (process.env.SASAPAY_ENV ?? "sandbox") : "unconfigured",
    collectionConfigured: hasPaymentCredentials(),
    payoutConfigured: hasPaymentCredentials() && !isPaymentSimulatorEnabled(),
    missingCollection: missingPaymentEnv(),
    missingPayout: missingPaymentEnv(),
    simulator: isPaymentSimulatorEnabled(),
    // M-Pesa-specific fields, reported as null here so the status shape is
    // uniform whichever provider is active. SasaPay's host comes from
    // SASAPAY_API_URL, which that provider validates on its own.
    baseUrl: null,
    configurationError: null,
  };
}
