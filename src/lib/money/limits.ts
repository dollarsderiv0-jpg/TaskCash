/**
 * Deposit bounds: the intersection of a currency's own limits and the
 * platform-wide settings.
 *
 * Why this is a function with a name rather than two lines inside the deposit
 * service: the customer-facing page and the server-side check must agree, and
 * they are written in different places by different people. They previously read
 * one input each — the page rendered `system_settings`, the service enforced
 * `max(currency.min_deposit, setting)` — so the deposit page advertised a KES 10
 * minimum and offered a quick-pick chip for it, while the server rejected
 * anything below KES 800 with "The minimum deposit is KES 800.00". Both callers
 * now compute the bounds the same way, so the page cannot promise an amount the
 * server will refuse.
 *
 * The currency column is the hard per-currency bound (0001 added the floor; 0017
 * added the ceiling, which did not exist before, so the only limit on a single
 * deposit was what the payment provider would accept). The setting is the
 * operator's day-to-day dial, so raising it can never lift a currency above its
 * own ceiling.
 */

export type DepositBoundsInput = {
  /** `currencies.min_deposit` — the hard per-currency floor. */
  currencyMinDeposit: number;
  /**
   * A local Daraja-sandbox floor, when one applies. See
   * `mpesaSandboxMinDeposit()` in `@/lib/env`, which returns null unless the
   * application is in development and pointed at Safaricom's sandbox.
   *
   * It may only ever LOWER `min`, so passing a value by mistake cannot make an
   * amount chargeable that would otherwise be refused.
   */
  sandboxMinDeposit?: number | null;
  /** `currencies.max_deposit` — `null`/`undefined` means the currency sets no ceiling. */
  currencyMaxDeposit: number | null | undefined;
  /** `system_settings['deposits.min_amount']` — the operator's dial. */
  settingMinDeposit: number;
  /** `system_settings['deposits.max_amount']` — the operator's dial. */
  settingMaxDeposit: number;
};

export type DepositBounds = {
  /** Smallest amount the server will accept, and the smallest the page may offer. */
  min: number;
  /** Largest amount the server will accept, and the largest the page may offer. */
  max: number;
  /**
   * Which input is binding on each side. Reported rather than inferred so an
   * operator looking at "minimum KES 800" can see it comes from the currency,
   * not from a setting they just changed and expected to take effect.
   */
  boundedBy: { min: "currency" | "setting" | "sandbox"; max: "currency" | "setting" };
};

export function effectiveDepositBounds(input: DepositBoundsInput): DepositBounds {
  const currencyMin = Number(input.currencyMinDeposit);
  const currencyMax =
    input.currencyMaxDeposit === null || input.currencyMaxDeposit === undefined
      ? Number.POSITIVE_INFINITY
      : Number(input.currencyMaxDeposit);

  let min = Math.max(currencyMin, input.settingMinDeposit);
  let minBound: DepositBounds["boundedBy"]["min"] =
    currencyMin >= input.settingMinDeposit ? "currency" : "setting";

  // Strictly a lowering. A sandbox floor at or above the real minimum is not a
  // test override at all, so it is ignored rather than reported — which keeps
  // "we are relaxed below the live floor" true whenever this is reported.
  const sandbox = input.sandboxMinDeposit;
  if (typeof sandbox === "number" && Number.isFinite(sandbox) && sandbox < min) {
    min = sandbox;
    minBound = "sandbox";
  }

  const max = Math.min(currencyMax, input.settingMaxDeposit);

  return {
    min,
    max,
    boundedBy: {
      min: minBound,
      max: currencyMax <= input.settingMaxDeposit ? "currency" : "setting",
    },
  };
}

/**
 * The quick-pick amounts to offer for a set of bounds.
 *
 * Filtered on BOTH sides. The previous list filtered only on the ceiling, which
 * is how a KES 500 chip stayed on a page whose floor was KES 800 — a control the
 * UI offered and the server then refused.
 */
export function depositQuickPicks(
  bounds: Pick<DepositBounds, "min" | "max">,
  candidates: number[],
): number[] {
  // An inverted window (floor above ceiling) accepts nothing, so it must offer
  // nothing. Returning the floor here would put a chip on the page for an amount
  // the server refuses — the exact failure this module exists to prevent.
  if (!(bounds.min <= bounds.max)) return [];

  const withinBounds = candidates.filter((value) => value >= bounds.min && value <= bounds.max);
  // Otherwise always include the floor, so the smallest valid amount is one tap
  // away even when every candidate sits above it.
  return [...new Set([bounds.min, ...withinBounds])].sort((a, b) => a - b);
}
