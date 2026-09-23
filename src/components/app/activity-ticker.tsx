"use client";

import * as React from "react";
import { ArrowDownToLine, ArrowUpFromLine, X } from "lucide-react";
import { apiRequest } from "@/lib/client/api";
import { formatMoney, relativeTime } from "@/lib/money/format";
import { cn } from "@/lib/utils";
import type { RecentActivityItem } from "@/lib/activity/mask";

/** One item every two seconds, as specified. */
const ROTATE_MS = 2_000;

/** How often the underlying data is refetched. Rotation is local; this is not. */
const REFRESH_MS = 60_000;

/** Remembered per browser, so a dismissed ticker stays dismissed. */
const DISMISS_KEY = "taskcash:activity-ticker:dismissed";

/**
 * Renders the band an amount fell in — never the amount.
 *
 * The bands are shown as "Under KES 500", "KES 5,000 – 10,000" and "KES 100,000+"
 * rather than as two figures, because the reader is meant to take away a sense of
 * scale, not a value they could tie to a person.
 */
function bandLabel(item: RecentActivityItem): string {
  const format = (value: number) =>
    formatMoney(value, item.currency, { compact: true, withSymbol: true });

  if (item.bandMin === 0 && item.bandMax !== null) return `Under ${format(item.bandMax)}`;
  if (item.bandMax === null) return `${format(item.bandMin)}+`;
  return `${format(item.bandMin)} – ${format(item.bandMax)}`;
}

/**
 * The signed-in activity ticker.
 *
 * WHAT THIS SHOWS, AND WHY IT IS NOT FABRICATED
 * ---------------------------------------------
 * Every item is a real, COMPLETED deposit or withdrawal belonging to somebody
 * else, with the identity reduced to a first name and an initial, the amount
 * reduced to a band, and the country reduced to two letters — all of that is
 * done server-side in `listRecentActivity`, before the data reaches the browser.
 * This component cannot un-mask anything, because it is never given anything to
 * un-mask.
 *
 * The consequence worth stating plainly: on a quiet platform this renders
 * NOTHING. That is the intended behaviour. A feed that keeps producing activity
 * when none has happened is not a feature, it is a lie with a spinning
 * animation, and it is the fastest way to teach a customer to disbelieve every
 * number this product shows them.
 */
export function ActivityTicker({ initialItems }: { initialItems: RecentActivityItem[] }) {
  const [items, setItems] = React.useState(initialItems);
  const [index, setIndex] = React.useState(0);
  const [dismissed, setDismissed] = React.useState(true);
  const [paused, setPaused] = React.useState(false);

  /*
    Dismissal is read in an effect, not during the first render, so the server
    and the client agree on the initial HTML. Reading localStorage while
    rendering would make the first client render differ from the server's and
    produce a hydration mismatch.
  */
  React.useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      // Storage can be unavailable (private mode, blocked cookies). Treated as
      // "not dismissed" rather than failing: the ticker is dismissible again on
      // the next render, which is the harmless direction.
      setDismissed(false);
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const result = await apiRequest<{ items: RecentActivityItem[]; available: boolean }>(
        "/api/activity/recent",
      );
      // A failed refresh keeps the last good data rather than blanking the
      // ticker: a transient 500 is not evidence that nothing happened.
      if (!cancelled && result.ok) setItems(result.data.items);
    };

    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  React.useEffect(() => {
    if (items.length === 0 || paused) return;
    const timer = window.setInterval(() => setIndex((current) => current + 1), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [items.length, paused]);

  const dismiss = React.useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Nothing to do — the in-memory dismissal above is already applied.
    }
  }, []);

  if (dismissed || items.length === 0) return null;

  // Wraps rather than resetting, so the transition never runs backwards.
  const item = items[index % items.length];
  const isDeposit = item.kind === "DEPOSIT";

  return (
    <div
      // Placed above the mobile bottom bar (bottom-20) and in the corner once
      // there is room. `aria-live` is deliberately OFF: a status region that
      // reannounces every two seconds makes the page unusable with a screen
      // reader, and this is ambient information, not an announcement.
      aria-live="off"
      className="pointer-events-none fixed bottom-20 left-4 z-50 w-[min(20rem,calc(100vw-2rem))] sm:bottom-6"
    >
      <div
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
        className={cn(
          "pointer-events-auto flex items-center gap-3 rounded-xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur",
          "motion-safe:animate-in motion-safe:slide-in-from-bottom-2 motion-safe:fade-in",
        )}
      >
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            isDeposit
              ? "bg-emeraldBrand-500/15 text-emeraldBrand-600 dark:text-emeraldBrand-400"
              : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
          )}
          aria-hidden
        >
          {isDeposit ? (
            <ArrowDownToLine className="h-4 w-4" />
          ) : (
            <ArrowUpFromLine className="h-4 w-4" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm leading-snug">
            <span className="font-semibold">{item.displayName}</span>{" "}
            <span className="text-muted-foreground">
              {isDeposit ? "deposited" : "withdrew"}
            </span>
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {bandLabel(item)} · {item.country} · {relativeTime(item.at)}
          </p>
        </div>

        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary"
          aria-label="Hide activity updates"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Dots, so it is visibly a rotating set rather than a single alert. */}
      {items.length > 1 ? (
        <div className="mt-1.5 flex justify-center gap-1" aria-hidden>
          {items.slice(0, 8).map((_, dot) => (
            <span
              key={dot}
              className={cn(
                "h-1 w-1 rounded-full transition-colors",
                dot === index % Math.min(items.length, 8) ? "bg-primary" : "bg-border",
              )}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
