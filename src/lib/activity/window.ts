/**
 * Which recent movements reach the ticker, and in what order.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * The service that fetches these rows cannot run without a database, so any
 * decision left inside it is a decision nothing can test. This one is worth
 * testing on its own because it is not a presentation detail: it decides
 * *whether* a whole category of real activity is ever shown to a customer.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * ------------------------------
 * Taking the newest `limit` rows of everything and stopping there looks correct
 * and is not. Deposits and withdrawals do not complete at a steady interleaved
 * rate; withdrawals settle in bursts, minutes or hours after the deposits that
 * funded them. So a window filled purely by recency can be one hundred percent
 * withdrawals — 24 of 24, real observed data — which means a ticker advertised
 * as showing "users depositing and withdrawing" never once shows a deposit, on
 * a platform where hundreds of deposits have completed.
 *
 * A feed that silently drops half of what it claims to show is a quieter lie
 * than a fabricated one, and harder to notice. Hence the rule below.
 */

import type { ActivityKind } from "./mask";

/** A movement the caller has already decided is eligible to be shown. */
export type RankedMovement = {
  kind: ActivityKind;
  /** When it completed, ISO. The only ordering key. */
  at: string;
};

/** The kinds a feed is expected to represent. Order is not significant. */
export const REPRESENTED_KINDS: readonly ActivityKind[] = ["DEPOSIT", "WITHDRAWAL"];

/**
 * The newest movements, trimmed to `limit`, with each represented kind given at
 * least one slot when any of its rows qualify.
 *
 * The result is still strictly newest-first. That is not an accident: a
 * movement is only ever missing from the top `limit` because it is older than
 * every row that made it, so the one forced in belongs at the end and pushing it
 * there preserves the ordering rather than disturbing it.
 *
 * Nothing is invented. When a kind has no qualifying rows — a platform where
 * nobody has withdrawn yet — the window is simply the newest of what exists.
 */
export function selectRecentWindow<T extends RankedMovement>(
  candidates: readonly T[],
  limit: number,
): T[] {
  const ordered = [...candidates].sort((a, b) => b.at.localeCompare(a.at));
  if (ordered.length <= limit) return ordered;

  const window = ordered.slice(0, limit);

  /*
    Fewer than two slots cannot hold both kinds, so one of them has to give way
    and recency decides which. Growing the window past the caller's limit is not
    a choice this function is entitled to make, and trimming is the lesser error.
  */
  if (window.length < 2) return window;

  /*
    With two kinds, a non-empty window whose slots all belong to one of them can
    be missing only the other, so one swap is always enough. A third kind would
    make this unsound; REPRESENTED_KINDS is where that would have to be noticed.
  */
  for (const kind of REPRESENTED_KINDS) {
    if (window.some((movement) => movement.kind === kind)) continue;

    const newestOfKind = ordered.find((movement) => movement.kind === kind);

    /*
      The oldest row in the window is what goes. That is a real trade and an
      honest one: the newest withdrawal is worth more to a reader than the 24th
      newest withdrawal, and the row being displaced is older than everything
      that remains.
    */
    if (newestOfKind) window[window.length - 1] = newestOfKind;
  }

  return window;
}
