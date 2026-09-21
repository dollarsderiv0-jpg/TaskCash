/**
 * M-Pesa (Daraja) error types.
 *
 * Two classes, and the distinction is load-bearing: a configuration error means
 * "we never called Safaricom", while a provider error means "we did, and here is
 * what it said". Reporting the first as the second is how a missing credential
 * gets logged as a customer's payment failing.
 */

export class MpesaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number | null = null,
    public readonly providerPayload: Record<string, unknown> | null = null,
    public readonly internalErrorId: string | null = null,
  ) {
    super(message);
    this.name = "MpesaError";
  }
}

export class PaymentConfigurationError extends MpesaError {
  /**
   * The variable NAMES that are missing or invalid — e.g. `MPESA_PASSKEY`, or
   * `MPESA_BASE_URL(=disagrees with MPESA_ENV)`.
   *
   * Kept as data as well as prose so status reporting can name the culprit
   * without parsing a sentence, and therefore without any risk of echoing a
   * value into a log, a health response or a ticket.
   */
  constructor(public readonly variables: string[]) {
    super(
      "PAYMENT_NOT_CONFIGURED",
      `Payment provider is not configured. Missing: ${variables.join(", ") || "credentials"}. ` +
        "Payments are disabled until these environment variables are set.",
    );
    this.name = "PaymentConfigurationError";
  }
}
