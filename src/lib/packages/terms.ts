/**
 * The one-line summary of a package's offer.
 *
 * WHY THIS EXISTS
 * ---------------
 * A package's `description` renders as a sentence directly above the table of
 * Price / Videos / Most per day / Most in total / Earning period, and the
 * sentence restates three of those figures. Two writers could set them
 * independently — migration 0014 seeded the sentence, and the admin form edits
 * it and the caps as separate fields — so the two drifted apart and the card
 * printed two different offers at once. After the package terms last moved,
 * Package 70000 read "up to KES 83,300 in total, for 14 days" in prose and
 * "Most in total KES 1,071,000.00, 180 days" in the table beneath it.
 *
 * The sentence is therefore treated as derived text: `describePackageTerms`
 * builds it from the figures being written, and `isGeneratedDescription` tells
 * the two generated forms apart from copy a person wrote. A hand-written
 * description does not match either pattern and is left exactly as it is.
 */

/* Grouped thousands, decimals kept as written — matching Postgres's
   to_char(x, 'FM999,999,990'), which is how 0014 seeded these rows. */
export function groupedAmount(value: number | string): string {
  const text = String(value);
  const [whole, fraction] = text.split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + grouped + (fraction ? `.${fraction}` : "");
}

/**
 * The sentence, in the exact form 0014 wrote: "Up to KES 68 per day from this
 * package's videos, up to KES 952 in total, for 14 days."
 *
 * The wording is load-bearing. It names a ceiling ("up to") and attributes the
 * money to the videos, because 0014's own note forbids the UI implying a return
 * or a payback period — the ceilings are only reachable while the campaigns
 * behind the videos still carry budget.
 */
export function describePackageTerms(input: {
  dailyEarningCap: number | string;
  lifetimeEarningCap: number | string;
  durationDays: number | string;
}): string {
  return (
    `Up to KES ${groupedAmount(input.dailyEarningCap)} per day from this package's videos, ` +
    `up to KES ${groupedAmount(input.lifetimeEarningCap)} in total, for ${input.durationDays} days.`
  );
}

const GENERATED_DESCRIPTION =
  /^Up to KES [\d,]+(?:\.\d+)? per day from this package's videos, up to KES [\d,]+(?:\.\d+)? in total, for \d+ days\.$/;

/** True when the text is one of ours to rewrite — a person's copy is not. */
export function isGeneratedDescription(text: unknown): boolean {
  return typeof text === "string" && GENERATED_DESCRIPTION.test(text);
}

/** The figures a description needs before it can say anything true. */
export function describesRealTerms(input: {
  dailyEarningCap: unknown;
  lifetimeEarningCap: unknown;
  durationDays: unknown;
}): boolean {
  const daily = Number(input.dailyEarningCap);
  const lifetime = Number(input.lifetimeEarningCap);
  const days = Number(input.durationDays);
  return daily > 0 && lifetime > 0 && days > 0;
}
