/**
 * Safaricom Daraja (M-Pesa) payload types.
 *
 * Field names and shapes are taken from the current Safaricom documentation:
 *   - M-Pesa Express (STK Push)  POST /mpesa/stkpush/v1/processrequest
 *   - M-Pesa Express Query       POST /mpesa/stkpushquery/v1/query
 *   - B2C Payment Request        POST /mpesa/b2c/v3/paymentrequest
 *
 * Note the B2C path is **v3**, not v1: Safaricom moved it, and posting v1 to
 * production is a silent 404. Note also that Daraja's own documentation spells
 * one optional field `Occassion`; we send that spelling and omit it entirely
 * when unset.
 *
 * Daraja reports failures as `{ requestId, errorCode, errorMessage }`, which is
 * a different shape from its success payloads — so both are modelled.
 */

/* -------------------------------------------------------------------------- */
/* Authentication                                                             */
/* -------------------------------------------------------------------------- */

export type DarajaTokenResponse = {
  access_token?: string;
  /** Seconds. Daraja issues ~3599. */
  expires_in?: string | number;
  token_type?: string;
};

/* -------------------------------------------------------------------------- */
/* Shared error shape                                                         */
/* -------------------------------------------------------------------------- */

export type DarajaErrorResponse = {
  requestId?: string;
  errorCode?: string;
  errorMessage?: string;
};

/* -------------------------------------------------------------------------- */
/* M-Pesa Express (STK Push) — collections                                    */
/* -------------------------------------------------------------------------- */

export type StkPushRequest = {
  BusinessShortCode: string;
  /** base64(ShortCode + Passkey + Timestamp) */
  Password: string;
  /** YYYYMMDDHHMMSS */
  Timestamp: string;
  TransactionType: "CustomerPayBillOnline" | "CustomerBuyGoodsOnline";
  /** Whole shillings only — Daraja rejects decimals here. */
  Amount: number;
  /** Customer MSISDN, 2547XXXXXXXX. */
  PartyA: string;
  PartyB: string;
  PhoneNumber: string;
  CallBackURL: string;
  /** Max 12 characters. */
  AccountReference: string;
  /** Max 13 characters. */
  TransactionDesc: string;
};

export type StkPushResponse = {
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResponseCode?: string;
  ResponseDescription?: string;
  CustomerMessage?: string;
};

export type StkQueryRequest = {
  BusinessShortCode: string;
  Password: string;
  Timestamp: string;
  CheckoutRequestID: string;
};

export type StkQueryResponse = {
  ResponseCode?: string;
  ResponseDescription?: string;
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  /** "0" when the customer paid; e.g. "1032" when they cancelled. */
  ResultCode?: string;
  ResultDesc?: string;
};

/**
 * The STK callback. A failing payment carries ResultCode/ResultDesc and NO
 * CallbackMetadata — so the receipt and the amount only exist on success, and
 * anything that needs the amount must handle its absence rather than assume it.
 */
export type StkCallbackPayload = {
  Body?: {
    stkCallback?: {
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      ResultCode?: string | number;
      ResultDesc?: string;
      CallbackMetadata?: {
        Item?: Array<{ Name?: string; Value?: string | number | null }>;
      };
    };
  };
};

/* -------------------------------------------------------------------------- */
/* B2C — disbursements                                                        */
/* -------------------------------------------------------------------------- */

export type B2cRequest = {
  /** Our idempotency key. A replayed value is rejected by Daraja. */
  OriginatorConversationID: string;
  InitiatorName: string;
  /** RSA-encrypted initiator password (Daraja portal or the public cert). */
  SecurityCredential: string;
  CommandID: "BusinessPayment" | "SalaryPayment" | "PromotionPayment";
  Amount: number;
  /** The B2C shortcode the money leaves. */
  PartyA: string;
  /** Recipient MSISDN, 2547XXXXXXXX. */
  PartyB: string;
  Remarks: string;
  QueueTimeOutURL: string;
  ResultURL: string;
  Occassion?: string;
};

export type B2cResponse = {
  ConversationID?: string;
  OriginatorConversationID?: string;
  ResponseCode?: string;
  ResponseDescription?: string;
};

/** The asynchronous result, POSTed to ResultURL. */
export type B2cResultPayload = {
  Result?: {
    ResultType?: number;
    /** 0 means paid. Anything else is a failure, and it is final. */
    ResultCode?: number | string;
    ResultDesc?: string;
    OriginatorConversationID?: string;
    ConversationID?: string;
    TransactionID?: string;
    /** Present only on success. */
    ResultParameters?: {
      ResultParameter?: Array<{ Key?: string; Value?: string | number | null }>;
    };
    ReferenceData?: { ReferenceItem?: { Key?: string; Value?: string } };
  };
};
