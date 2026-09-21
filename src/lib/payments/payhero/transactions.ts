import { pickNumber, pickString } from "@/lib/payments/parse";
import { payheroRequest } from "@/lib/payments/payhero/client";
import { outcomeFromPayhero } from "@/lib/payments/payhero/verify";
import type { PaymentOutcome } from "@/lib/payments/types";

/**
 * The provider-side transaction list.
 *
 * This is the *inverse* direction to every other reconciliation path in the
 * product. Everything else starts from a local record and asks "what did the
 * provider say?". This starts from the provider and asks "what did you pay that
 * we have no record of?" — which is the only way to find a payment that was
 * taken and never credited, or a payment we never even created a row for.
 *
 * `GET /transactions?page=&per_page=` is the endpoint PayHero's own SDK uses for
 * this (`getAccountTransactions` in `payhero-php`). Its response envelope is not
 * pinned by the documentation we could read, so it is parsed defensively and
 * reports honestly when it does not recognise the shape — see
 * `formatUnrecognised` below. Reporting "nothing to reconcile" because we could
 * not read the response is the one failure this must never have.
 */

export type ProviderPayment = {
  /** PayHero's own reference for the transaction. */
  reference: string | null;
  /** Our reference, echoed back — this is what identifies our deposit. */
  externalReference: string | null;
  amount: number | null;
  outcome: PaymentOutcome;
  /** The M-Pesa receipt number, which is what a customer quotes. */
  receipt: string | null;
  phone: string | null;
  /** Provider timestamp, when present. ISO or the provider's own string. */
  occurredAt: string | null;
  /** The row exactly as the provider sent it, for the alert details. */
  raw: Record<string, unknown>;
};

export type ProviderPaymentPage = {
  items: ProviderPayment[];
  /** Rows the provider returned that carried no reference we could read. */
  unreadable: number;
  /** True when the provider sent rows but we understood none of them. */
  formatUnrecognised: boolean;
  /** Where in the payload the rows were found, for diagnosis. */
  envelope: string;
};

/** Candidate keys the rows may live under, tried in order. */
const ROW_KEYS = ["data", "transactions", "results", "items", "records", "payments"];

/**
 * Reads the rows out of whatever envelope the provider used.
 *
 * Split out as a pure function so the shapes can be tested without a network
 * call — the branches here are exactly the ones that must not silently yield an
 * empty list.
 */
export function readTransactionRows(payload: unknown): { rows: unknown[]; envelope: string } {
  if (Array.isArray(payload)) return { rows: payload, envelope: "(bare array)" };
  if (!payload || typeof payload !== "object") return { rows: [], envelope: "(none)" };

  const top = payload as Record<string, unknown>;

  for (const key of ROW_KEYS) {
    const value = top[key];
    if (Array.isArray(value)) return { rows: value, envelope: key };
    // A nested envelope, e.g. { data: { transactions: [...] } }.
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      for (const innerKey of ROW_KEYS) {
        if (Array.isArray(nested[innerKey])) {
          return { rows: nested[innerKey] as unknown[], envelope: `${key}.${innerKey}` };
        }
      }
    }
  }

  return { rows: [], envelope: "(unrecognised)" };
}

/** Normalises one provider row. Returns null when it carries no usable reference. */
export function normalizeProviderPayment(row: unknown): ProviderPayment | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;

  const reference = pickString(record, [
    "reference",
    "Reference",
    "transaction_reference",
    "CheckoutRequestID",
  ]);
  const externalReference = pickString(record, [
    "external_reference",
    "ExternalReference",
    "account_reference",
    "AccountReference",
  ]);

  /*
    A row with neither identifier cannot be matched to anything we hold, and
    cannot be reported usably either — there would be nothing for an operator to
    search on. It is counted as unreadable instead of being dropped silently.
  */
  if (!reference && !externalReference) return null;

  const status = pickString(record, ["status", "Status", "transaction_status", "TransactionStatus"]);
  const resultCode = pickString(record, ["ResultCode", "ResponseCode", "result_code"]);
  const description = pickString(record, ["ResultDesc", "message", "detail", "response_description"]);

  return {
    reference,
    externalReference,
    amount: pickNumber(record, ["amount", "Amount", "TransactionAmount", "TransAmount"]),
    outcome: outcomeFromPayhero(status, resultCode, description),
    receipt: pickString(record, [
      "MpesaReceiptNumber",
      "transaction_code",
      "TransactionCode",
      "receipt_number",
    ]),
    phone: pickString(record, ["phone_number", "PhoneNumber", "MSISDN", "customer_mobile"]),
    occurredAt: pickString(record, [
      "transaction_date",
      "created_at",
      "date",
      "TransactionDate",
      "updated_at",
    ]),
    raw: record,
  };
}

export function parseProviderPaymentPage(payload: unknown): ProviderPaymentPage {
  const { rows, envelope } = readTransactionRows(payload);

  const items: ProviderPayment[] = [];
  let unreadable = 0;
  for (const row of rows) {
    const payment = normalizeProviderPayment(row);
    if (payment) items.push(payment);
    else unreadable += 1;
  }

  return {
    items,
    unreadable,
    // Rows arrived, none were understood. Almost always a renamed field at the
    // provider — and it must be visible, because the alternative is a sweep that
    // reports a clean run while blind.
    formatUnrecognised: rows.length > 0 && items.length === 0,
    envelope,
  };
}

export type ListProviderPaymentsInput = {
  page?: number;
  perPage?: number;
};

/**
 * One page of the provider's transactions, newest first as PayHero returns them.
 *
 * A collection may be retried (`GET` is idempotent and this is a read), unlike a
 * payout.
 */
export async function listProviderTransactions(
  input: ListProviderPaymentsInput = {},
): Promise<ProviderPaymentPage> {
  const page = input.page ?? 1;
  const perPage = Math.min(Math.max(input.perPage ?? 100, 1), 200);

  const payload = await payheroRequest<unknown>(
    `/transactions?page=${page}&per_page=${perPage}`,
    {
      method: "GET",
      operation: "transactions.list",
      retryable: true,
      requestReference: `page-${page}`,
    },
  );

  return parseProviderPaymentPage(payload);
}
