import { isPaymentSimulatorEnabled, isProduction } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * DEVELOPMENT-ONLY provider simulator.
 *
 * Purpose: let a developer exercise the real deposit/withdrawal pipeline
 * (records, ledger entries, callbacks, idempotency, reconciliation) without
 * live merchant credentials.
 *
 * Guarantees:
 *  - Enabled only when SASAPAY_SIMULATOR=1 AND NODE_ENV !== "production".
 *  - It never writes to the database. It only substitutes the *provider's*
 *    HTTP response; every downstream rule still runs for real.
 *  - Every simulated record is tagged `SIMULATED` in its metadata so simulated
 *    activity can never be mistaken for real settlement.
 *
 * Outcome control for local testing, encoded in the AccountReference:
 *   "...-FAIL"    -> the transaction fails
 *   "...-CANCEL"  -> the customer cancels
 *   "...-PENDING" -> stays pending forever (tests reconciliation)
 *   anything else -> succeeds
 */

type SimulatedFetchOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  operation: string;
  requestReference?: string | null;
};

export const SIMULATED_TAG = "SIMULATED";

function markerFrom(body: Record<string, unknown>): "OK" | "FAIL" | "CANCEL" | "PENDING" {
  const reference = String(
    body.AccountReference ?? body.transaction_ref ?? body.CheckoutRequestID ?? "",
  ).toUpperCase();
  if (reference.includes("FAIL")) return "FAIL";
  if (reference.includes("CANCEL")) return "CANCEL";
  if (reference.includes("PENDING")) return "PENDING";
  return "OK";
}

function fakeId(prefix: string, marker: string) {
  const hex = Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10)).join("-");
  return `${marker}-${prefix}-${hex}`;
}

export async function simulateRequest<T>(
  path: string,
  options: SimulatedFetchOptions,
): Promise<T> {
  if (isProduction() || !isPaymentSimulatorEnabled()) {
    throw new Error(
      "Payment simulator is disabled. Configure real SasaPay credentials to process payments.",
    );
  }

  const body = (options.body ?? {}) as Record<string, unknown>;

  logger.warn("sasapay_simulator_in_use", {
    path,
    operation: options.operation,
    requestReference: options.requestReference ?? null,
    note: "No real money is moving. Responses are fabricated for local development only.",
  });

  if (path.includes("/auth/token/")) {
    return {
      status: true,
      detail: "Simulated authentication successful",
      access_token: "simulated-access-token",
      token_type: "Bearer",
      expires_in: 3600,
    } as T;
  }

  if (path.includes("/payments/request-payment/")) {
    const marker = markerFrom(body);
    const checkoutId = fakeId("checkout", marker);
    return {
      status: marker !== "FAIL",
      detail:
        marker === "FAIL"
          ? "Simulated failure: request rejected"
          : "Simulated: payment request accepted",
      MerchantRequestID: fakeId("merchant", marker),
      CheckoutRequestID: checkoutId,
      ResponseCode: marker === "FAIL" ? "1" : "0",
      simulated: true,
    } as T;
  }

  if (path.includes("/payments/process-payment/")) {
    const marker = markerFrom(body);
    return {
      status: marker !== "FAIL",
      detail: marker === "FAIL" ? "Simulated failure" : "Simulated: payment submitted for processing",
      ResponseCode: marker === "FAIL" ? "1" : "0",
      simulated: true,
    } as T;
  }

  if (path.includes("/payments/b2c/")) {
    const marker = markerFrom(body);
    return {
      status: marker !== "FAIL",
      detail: marker === "FAIL" ? "Simulated failure: disbursement rejected" : "Simulated: transaction is being processed",
      CheckoutRequestID: fakeId("b2c", marker),
      MerchantRequestID: fakeId("merchant", marker),
      ResponseCode: marker === "FAIL" ? "1" : "0",
      simulated: true,
    } as T;
  }

  if (path.includes("/payments/transaction-status/")) {
    const checkoutId = String(body.CheckoutRequestID ?? "");
    const marker = checkoutId.startsWith("FAIL")
      ? "FAIL"
      : checkoutId.startsWith("CANCEL")
        ? "CANCEL"
        : checkoutId.startsWith("PEND")
          ? "PENDING"
          : "OK";

    const resultCode = marker === "OK" ? "0" : marker === "CANCEL" ? "1037" : marker === "PENDING" ? "1001" : "1";

    return {
      status: marker === "OK",
      detail:
        marker === "OK"
          ? "Simulated: transaction completed successfully"
          : marker === "PENDING"
            ? "Simulated: transaction still processing"
            : "Simulated: transaction not successful",
      ResultCode: resultCode,
      TransactionStatus: marker === "OK" ? "COMPLETED" : marker === "PENDING" ? "PENDING" : "FAILED",
      TransactionCode: marker === "OK" ? fakeId("txn", "OK") : null,
      TransactionAmount: body.Amount ?? null,
      simulated: true,
    } as T;
  }

  return { status: false, detail: "Simulated endpoint not implemented", simulated: true } as T;
}
