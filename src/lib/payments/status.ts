/**
 * The payment status a client is allowed to see.
 *
 * Our records carry more states than a customer needs to reason about (a
 * REJECTED deposit and a FAILED one are the same thing to the person who was
 * charged, and PROCESSING is not meaningfully different from PENDING). This
 * collapses them onto the five words the frontend actually branches on, in one
 * place, so no screen invents its own reading of a status.
 *
 * The direction that matters is the safe one: anything we do not positively
 * recognise becomes `unknown`, never `successful`. A status we have never seen
 * must not read as money arriving.
 */

export type PaymentStatus = "pending" | "successful" | "failed" | "cancelled" | "unknown";

/**
 * Maps one of our deposit statuses onto the client-facing status.
 *
 * `SUCCESSFUL` is reachable only from `COMPLETED`, which is itself only written
 * after the provider independently confirms the payment — so this mapping cannot
 * promote an unconfirmed record into a successful one.
 */
export function paymentStatusFromDepositStatus(status: string | null | undefined): PaymentStatus {
  switch ((status ?? "").trim().toUpperCase()) {
    case "COMPLETED":
      return "successful";
    case "PENDING":
    case "PROCESSING":
      return "pending";
    case "FAILED":
    case "REJECTED":
      return "failed";
    case "CANCELLED":
    case "REVERSED":
      return "cancelled";
    default:
      return "unknown";
  }
}
