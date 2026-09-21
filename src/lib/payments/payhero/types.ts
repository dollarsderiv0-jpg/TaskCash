/**
 * PayHero API types.
 *
 * Field names follow PayHero's current v2 API as documented at
 * https://docs.payhero.co.ke and as used by PayHero's own official SDK
 * (`payhero-php`): snake_case request bodies (`phone_number`, `channel_id`,
 * `external_reference`, `callback_url`) and a `{ success, status, reference }`
 * response envelope.
 *
 * Every response type is intentionally permissive (`[key: string]: unknown`)
 * because a provider adding or renaming a field must degrade to "we could not
 * read that" rather than to a crash — or, far worse, to a wrong amount being
 * read as the settled figure.
 */

/* -------------------------------------------------------------------------- */
/* Collections (STK push)                                                     */
/* -------------------------------------------------------------------------- */

/** `POST /payments` — asks PayHero to prompt the customer's phone. */
export type StkPushRequest = {
  amount: number;
  /** MSISDN. PayHero accepts `2547…` and `07…`; we always send E.164 digits. */
  phone_number: string;
  /** Your registered payment channel id, from the PayHero dashboard. */
  channel_id: number;
  /** Our own reference — the only field we can use to find this again. */
  external_reference: string;
  callback_url: string;
  /** `m-pesa` for the M-Pesa STK push; PayHero also accepts `sasapay`. */
  provider: "m-pesa" | "sasapay";
};

/**
 * The 201 envelope. `status` is `QUEUED` on acceptance — which means the prompt
 * was dispatched, never that money moved.
 */
export type StkPushResponse = {
  success?: boolean | string;
  status?: string;
  /** PayHero's own reference for this transaction. */
  reference?: string;
  /** Safaricom's id, present once the request reaches Daraja. */
  CheckoutRequestID?: string;
  MerchantRequestID?: string;
  amount?: number | string;
  message?: string;
  detail?: string;
  error?: string;
  errorMessage?: string;
  [key: string]: unknown;
};

/* -------------------------------------------------------------------------- */
/* Transaction status                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `GET /transaction-status?reference=…`
 *
 * `reference` accepts either our `external_reference` or PayHero's own
 * reference. The provider wraps much of the underlying result in `response`,
 * so the reader merges both levels before interpreting it.
 */
export type TransactionStatusResponse = {
  success?: boolean | string;
  status?: string;
  reference?: string;
  amount?: number | string;
  phone_number?: string;
  /** The nested provider result, when present. */
  response?: Record<string, unknown>;
  message?: string;
  detail?: string;
  [key: string]: unknown;
};

/* -------------------------------------------------------------------------- */
/* Disbursements (withdrawals)                                                */
/* -------------------------------------------------------------------------- */

/** `POST /withdraw` — pays out to a mobile number. */
export type WithdrawRequest = {
  amount: number;
  phone_number: string;
  /** SasaPay network code identifying the recipient's telco. */
  network_code: string;
  external_reference: string;
  callback_url: string;
  channel: "mobile" | "bank";
};

export type WithdrawResponse = StkPushResponse;

/* -------------------------------------------------------------------------- */
/* Callback                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The webhook body.
 *
 * Names differ between PayHero's own delivery and the Daraja result it forwards
 * (`MpesaReceiptNumber` vs `transaction_code`), so every field is read through a
 * candidate list rather than by one exact key.
 */
export type CallbackPayload = {
  status?: string;
  reference?: string;
  external_reference?: string;
  CheckoutRequestID?: string;
  MerchantRequestID?: string;
  amount?: number | string;
  phone_number?: string;
  MpesaReceiptNumber?: string;
  transaction_code?: string;
  ResultCode?: string | number;
  ResultDesc?: string;
  [key: string]: unknown;
};

/* -------------------------------------------------------------------------- */
/* Normalized internal outcome                                                */
/* -------------------------------------------------------------------------- */

// These describe what the *application* needs from any provider, so they live
// in the provider-agnostic module and are re-exported here for convenience.
// Defining them a second time is how two providers drift apart.
export type {
  PaymentOutcome,
  NormalizedCallback,
  ProviderResult,
} from "@/lib/payments/types";
