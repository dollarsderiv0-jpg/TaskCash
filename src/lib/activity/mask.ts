/**
 * The masking rules behind the signed-in activity ticker.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * These are the functions that decide what one customer is allowed to learn
 * about another customer's money, so they are pure, synchronous, dependency-free
 * and therefore directly testable — `npm run test:activity-mask` pins every rule
 * below. Keeping them out of the service that queries Postgres is what makes
 * that possible, and it is also what lets the ticker component import the row
 * type without importing a server-only Supabase client.
 *
 * Three rules, and none of them are cosmetic:
 *
 *   1. An AMOUNT never escapes. A band is a shape; a figure is a position.
 *   2. An IDENTITY never escapes. A first name and an initial, plus a two-letter
 *      country — no profile id, no name on the account, no contact detail.
 *   3. Nothing here invents a row. These functions only ever reduce what the
 *      database returned.
 */

export type ActivityKind = "DEPOSIT" | "WITHDRAWAL";

/** What a client is allowed to see. There is no id field, on purpose. */
export type RecentActivityItem = {
  kind: ActivityKind;
  /** A first name and an initial. Never the name on the account. */
  displayName: string;
  /** ISO 3166-1 alpha-2. Never a phone number, email or address. */
  country: string;
  /** Inclusive lower bound of the amount band, in whole currency units. */
  bandMin: number;
  /** Exclusive upper bound, or null for the open-ended top band. */
  bandMax: number | null;
  currency: string;
  /** When the movement completed, ISO. */
  at: string;
};

/**
 * Amount bands, in whole units of the currency.
 *
 * Coarse on purpose: with a small user base, an exact amount beside a first name
 * can identify the transaction to anyone who knows the person. The widest band
 * is open-ended, so an unusually large movement is never singled out by being
 * given a band of its own.
 */
export const BAND_BOUNDS = [500, 1_000, 5_000, 10_000, 50_000, 100_000] as const;

export function amountBand(amount: number): { bandMin: number; bandMax: number | null } {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { bandMin: 0, bandMax: BAND_BOUNDS[0] };
  }

  for (let index = 0; index < BAND_BOUNDS.length; index += 1) {
    if (amount < BAND_BOUNDS[index]) {
      return {
        bandMin: index === 0 ? 0 : BAND_BOUNDS[index - 1],
        bandMax: BAND_BOUNDS[index],
      };
    }
  }

  return { bandMin: BAND_BOUNDS[BAND_BOUNDS.length - 1], bandMax: null };
}

/**
 * "Mary Wanjiru Kamau" -> "Mary K.". "Catherine" -> "Catherine". "Jo" -> "J.".
 *
 * A single-token name is only used in full when it is long enough not to be
 * identifying on its own — a two-letter first name next to a country and an
 * amount band is a name again. A missing name degrades to "A member" rather than
 * to an empty string or a placeholder that pretends to be a person.
 */
export function maskName(fullName: string | null | undefined): string {
  const trimmed = (fullName ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed) return "A member";

  const parts = trimmed.split(" ");
  const given = parts[0].slice(0, 24);
  if (!given) return "A member";

  if (parts.length === 1) {
    return given.length >= 4 ? given : `${given.slice(0, 1).toUpperCase()}.`;
  }

  const initial = parts[parts.length - 1].slice(0, 1).toUpperCase();
  return initial ? `${given} ${initial}.` : given;
}

/** A country code reduced to two uppercase letters, or a dash when absent. */
export function maskCountry(country: string | null | undefined): string {
  const code = (country ?? "").trim().toUpperCase().slice(0, 2);
  return /^[A-Z]{2}$/.test(code) ? code : "—";
}
