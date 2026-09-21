/**
 * PayHero error types.
 *
 * Two classes, and the distinction is load-bearing: a configuration error means
 * "we never called PayHero", while a provider error means "we did, and here is
 * what it said". Reporting the first as the second is how a missing credential
 * gets logged, and billed, as a customer's payment failing.
 *
 * Deliberately the same shape as `@/lib/payments/mpesa/errors`, because
 * `withdrawals.ts` inspects `error.code === "PAYMENT_NOT_CONFIGURED"` and must
 * not need a provider-specific branch to keep a hold held when the platform
 * itself is misconfigured.
 */

export class PayHeroError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number | null = null,
    public readonly providerPayload: Record<string, unknown> | null = null,
    public readonly internalErrorId: string | null = null,
  ) {
    super(message);
    this.name = "PayHeroError";
  }
}

export class PaymentConfigurationError extends PayHeroError {
  /**
   * The variable NAMES that are missing or invalid — e.g. `PAYHERO_CHANNEL_ID`,
   * or `PAYHERO_API_URL(=not a PayHero host)`.
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
