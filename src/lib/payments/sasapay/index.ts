/**
 * SasaPay payment service.
 *
 * Public surface used by the application:
 *   auth.ts     — OAuth token acquisition and caching
 *   client.ts   — transport, retries, timeouts, safe errors
 *   collect.ts  — C2B collections (deposits)
 *   disburse.ts — B2C disbursements (withdrawals, admin-approved only)
 *   verify.ts   — authoritative transaction-status confirmation
 *   callback.ts — callback parsing and authenticity checks
 *   types.ts    — provider payload types
 */

export { getAccessToken, invalidateAccessToken, paymentProviderStatus } from "./auth";
export {
  SasaPayError,
  PaymentConfigurationError,
  resolveApiBase,
  pickNumber,
  pickString,
  providerSaysOk,
} from "./client";
export { initiateCollection, processCollectionOtp, defaultCallbackUrl } from "./collect";
export { disburseToCustomer } from "./disburse";
export {
  queryTransactionStatus,
  verifyCollection,
  verifyDisbursement,
  outcomeFromCode,
  type VerificationVerdict,
} from "./verify";
export { normalizeCallback, checkCallbackAuthenticity, parseCallbackBody } from "./callback";
export { SIMULATED_TAG } from "./simulator";
export type { ProviderResult, PaymentOutcome, NormalizedCallback } from "./types";
