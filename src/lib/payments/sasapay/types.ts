/**
 * SasaPay API types.
 *
 * Field names follow the current SasaPay API (MerchantCode / NetworkCode /
 * AccountReference / CallBackURL), which differs from the older
 * `biller_number` generation of the docs. Hosts are configurable because the
 * exact base URL must come from the merchant's own SasaPay dashboard.
 */

export type SasaPayEnvironment = "sandbox" | "production";

/* -------------------------------------------------------------------------- */
/* Authentication                                                             */
/* -------------------------------------------------------------------------- */

export type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  refresh_token?: string;
  status?: boolean;
  detail?: string;
  auth_details?: {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
    refresh_token?: string;
  };
};

/* -------------------------------------------------------------------------- */
/* C2B collection                                                             */
/* -------------------------------------------------------------------------- */

export type CollectionRequest = {
  MerchantCode: string;
  /** Channel/network identifier provided by SasaPay for the market. */
  NetworkCode: string;
  PhoneNumber: string;
  Amount: number;
  Currency: string;
  AccountReference: string;
  TransactionDesc: string;
  CallBackURL: string;
};

export type CollectionResponse = {
  status?: boolean | string;
  detail?: string;
  message?: string;
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  checkout_id?: string;
  ResponseCode?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type ProcessCollectionRequest = {
  MerchantCode: string;
  CheckoutRequestID: string;
  VerificationCode: string;
};

/* -------------------------------------------------------------------------- */
/* B2C disbursement                                                           */
/* -------------------------------------------------------------------------- */

export type DisbursementRequest = {
  MerchantCode: string;
  Amount: number;
  Currency?: string;
  /** Recipient mobile number in international or local format. */
  ReceiverNumber: string;
  /** SasaPay channel code for the destination network. */
  ChannelCode: string;
  CallBackURL: string;
  TransactionDesc: string;
  AccountReference: string;
};

export type DisbursementResponse = {
  status?: boolean | string;
  detail?: string;
  message?: string;
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResponseCode?: string;
  errorCode?: string;
  errorMessage?: string;
  transaction?: Record<string, unknown>;
};

/* -------------------------------------------------------------------------- */
/* Transaction status                                                         */
/* -------------------------------------------------------------------------- */

export type TransactionStatusRequest = {
  MerchantCode: string;
  CheckoutRequestID: string;
};

export type TransactionStatusResponse = {
  status?: boolean | string;
  detail?: string;
  message?: string;
  ResponseCode?: string;
  ResultCode?: string;
  /** SasaPay's own record of the payment. */
  TransactionCode?: string;
  TransactionAmount?: string | number;
  TransactionDate?: string;
  TransactionType?: string;
  TransactionStatus?: string;
  ReceiverAccountNumber?: string;
  errorCode?: string;
  errorMessage?: string;
  [key: string]: unknown;
};

/* -------------------------------------------------------------------------- */
/* Normalized internal outcome                                                */
/* -------------------------------------------------------------------------- */

// These three describe what the *application* needs from any provider, so they
// live in the provider-agnostic module and are re-exported here for the many
// existing imports. Defining them twice is how two providers drift apart.
export type {
  PaymentOutcome,
  NormalizedCallback,
  ProviderResult,
} from "@/lib/payments/types";
