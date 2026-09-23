/**
 * The masking rules behind the signed-in activity popup.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * These are the functions that decide what one customer is allowed to learn
 * about another customer's money, so they are pure, synchronous,
 * dependency-free and therefore directly testable — `npm run test:activity-mask`
 * pins every rule below. Keeping them out of the service that queries Postgres
 * is what makes that possible, and it is also what lets the popup component
 * import the row type without importing a server-only Supabase client.
 *
 * WHAT IS REDUCED, AND WHAT IS NOT
 * --------------------------------
 *   1. An IDENTITY is reduced. A first name and an initial, plus a two-letter
 *      country — no profile id, no name on the account, no contact detail.
 *
 *   2. An AMOUNT is NOT reduced. The popup shows the real figure, as asked for.
 *      This is the one place in the codebase where a customer's actual money
 *      movement is rendered to another customer, and it is worth being plain
 *      about: an earlier version of this feature reduced every amount to a
 *      range, and that reduction is deliberately gone rather than merely
 *      bypassed. Nothing downstream applies it. If amounts ever need to stop
 *      travelling, they stop HERE, and `amount` on the item type below is the
 *      contract every caller depends on.
 *
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
  /** The real amount, in whole units of `currency`. */
  amount: number;
  currency: string;
  /** When the movement completed, ISO. */
  at: string;
};

/**
 * "Mary Wanjiru Kamau" -> "Mary K.". "Catherine" -> "Catherine". "Jo" -> "J.".
 *
 * A single-token name is only used in full when it is long enough not to be
 * identifying on its own — a two-letter first name next to a country and an
 * amount is a name again. A missing name degrades to "A member" rather than to
 * an empty string or a placeholder that pretends to be a person.
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
