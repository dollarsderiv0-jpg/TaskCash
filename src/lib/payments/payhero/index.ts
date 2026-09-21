/**
 * PayHero payment service.
 *
 * Public surface used by the application:
 *   config.ts    — credentials, host validation, channel and callback settings
 *   client.ts    — transport (HTTP Basic), timeouts, bounded retries, safe errors
 *   collect.ts   — collections (deposits), the M-Pesa STK push PayHero fronts
 *   disburse.ts  — payouts (withdrawals, admin-approved only)
 *   verify.ts    — authoritative transaction-status confirmation
 *   callback.ts  — webhook parsing and authenticity checks
 *   readiness.ts — whether a payout can actually be sent
 *   types.ts     — provider payload types
 *
 * `@/lib/payments/provider` is what the rest of the app should import: it picks
 * between this, M-Pesa and SasaPay from configuration, so the financial
 * services never name a provider.
 */

export { PayHeroError, PaymentConfigurationError } from "./errors";
export {
  payheroRequest,
  payheroAuthHeader,
  pickString,
  pickNumber,
  providerSaysOk,
} from "./client";
export { initiateCollection, toPayheroMsisdn, type InitiateCollectionInput } from "./collect";
export { disburseToCustomer, type DisburseInput } from "./disburse";
export {
  queryTransactionStatus,
  verifyCollection,
  verifyDisbursement,
  outcomeFromPayhero,
} from "./verify";
export {
  normalizeCallback,
  checkCallbackAuthenticity,
  type CallbackAuthenticity,
} from "./callback";
export { payoutReadiness } from "./readiness";
export {
  collectionConfig,
  payoutConfig,
  payheroCredentials,
  payheroConfigStatus,
  resolveApiBase,
  defaultCallbackUrl,
  PAYHERO_DEFAULT_BASE_URL,
} from "./config";
export { PAYHERO_COLLECTION_KEYS, PAYHERO_PAYOUT_KEYS } from "@/lib/env";
export type { ProviderResult, PaymentOutcome, NormalizedCallback } from "./types";
