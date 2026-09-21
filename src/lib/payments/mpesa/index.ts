/**
 * Safaricom Daraja (M-Pesa) payment service.
 *
 * Public surface used by the application:
 *   auth.ts      — OAuth token acquisition and caching
 *   client.ts    — transport, timeouts, safe errors, no-retry-by-default
 *   stk.ts       — M-Pesa Express collections (deposits)
 *   b2c.ts       — B2C disbursements (withdrawals, admin-approved only)
 *   verify.ts    — authoritative confirmation for both directions
 *   callback.ts  — callback parsing and source authenticity checks
 *   config.ts    — credentials, hosts and callback URLs
 *   types.ts     — provider payload types
 *
 * `@/lib/payments/provider` is what the rest of the app should import: it
 * picks between this and SasaPay from configuration, so the financial services
 * never name a provider.
 */

export { getAccessToken, invalidateAccessToken } from "./auth";
export { MpesaError, PaymentConfigurationError, darajaRequest } from "./client";
export { disburseToCustomer } from "./b2c";
export {
  initiateStkPush,
  queryStkStatus,
  darajaTimestamp,
  stkPassword,
  assertWholeShillings,
  outcomeFromStkResultCode,
  ACCOUNT_REFERENCE_MAX,
  TRANSACTION_DESC_MAX,
} from "./stk";
export {
  checkMpesaCallbackAuthenticity,
  parseStkCallback,
  parseB2cResult,
  parseCallbackBody,
  stkCallbackMetadata,
  resultParameterMap,
} from "./callback";
export { verifyCollection, verifyDisbursement } from "./verify";
export { mpesaPayoutReadiness } from "./readiness";
export {
  collectionConfig,
  payoutConfig,
  mpesaConfigStatus,
  mpesaEnvironment,
  hasMpesaCollectionCredentials,
  hasMpesaPayoutCredentials,
  missingMpesaCollectionEnv,
  missingMpesaPayoutEnv,
} from "./config";
// The canonical credential lists live with the rest of the environment
// authority, so they cannot drift from what preflight checks.
export { MPESA_COLLECTION_KEYS, MPESA_PAYOUT_KEYS } from "@/lib/env";
export type { MpesaCollectionConfig, MpesaPayoutConfig, MpesaEnvironment } from "./config";
export type * from "./types";
