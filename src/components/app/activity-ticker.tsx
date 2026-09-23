"use client";

import * as React from "react";
import { ArrowDownToLine, ArrowUpFromLine, X } from "lucide-react";
import { apiRequest } from "@/lib/client/api";
import { formatMoney, relativeTimeWords } from "@/lib/money/format";
import { cn } from "@/lib/utils";
import type { RecentActivityItem } from "@/lib/activity/mask";

/** How long one movement stays on screen, as specified. */
const VISIBLE_MS = 5_000;

/** Must match the `duration-300` on the card, or the fade and the swap disagree. */
const FADE_MS = 300;

/** The quiet beat between one movement leaving and the next arriving. */
const GAP_MS = 700;

/** How often the underlying data is refetched. Rotation is local; this is not. */
const REFRESH_MS = 60_000;

/** Remembered per browser, so a dismissed popup stays dismissed. */
const DISMISS_KEY = "taskcash:activity-ticker:dismissed";

/**
 * The signed-in activity popup.
 *
 * WHAT THIS SHOWS, AND WHY IT IS NOT FABRICATED
 * ---------------------------------------------
 * Every item is a real, COMPLETED deposit or withdrawal belonging to somebody
 * else. The identity is reduced to a first name and an initial, and the country
 * to two letters — both server-side, in `listRecentActivity`, before the data
 * reaches the browser. This component cannot un-mask anything, because it is
 * never given anything to un-mask.
 *
 * ONE AT A TIME, BY CONSTRUCTION
 * ------------------------------
 * There is exactly one card in the tree at every moment. The next movement is
 * not swapped in until the current one has finished fading out, so the two can
 * never be visible together and nothing is ever remounted mid-fade — which is
 * what a flicker actually is. The visible time is a timeout rather than an
 * animation duration, so the five seconds a reader gets is five seconds of
 * readable content, not five seconds minus the fade in.
 *
 * The consequence worth stating plainly: on a quiet platform the feed is empty
 * and this renders NOTHING. That is the intended behaviour. A popup that keeps
 * producing activity when none has happened is not a feature, it is a lie with a
 * slide animation, and it is the fastest way to teach a customer to disbelieve
 * every number this product shows them.
 */
export function ActivityTicker({ initialItems }: { initialItems: RecentActivityItem[] }) {
  const [items, setItems] = React.useState(initialItems);
  const [index, setIndex] = React.useState(0);
  const [shown, setShown] = React.useState(false);
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
      // "not dismissed" rather than failing: the popup is dismissible again on
      // the next render, which is the harmless direction.
      setDismissed(false);
    }
  }, []);

  /*
    The entrance. `shown` starts false, so the first paint — on the server and
    on the client — is the hidden state, and the transition into the visible one
    happens on the next frame. That is what makes the popup fade in and slide
    down on load instead of appearing already open.
  */
  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => setShown(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const result = await apiRequest<{ items: RecentActivityItem[]; available: boolean }>(
        "/api/activity/recent",
      );
      // A failed refresh keeps the last good data rather than blanking the
      // popup: a transient 500 is not evidence that nothing happened.
      if (!cancelled && result.ok) setItems(result.data.items);
    };

    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  /*
    The cycle: visible for five seconds, fade out, a short beat, then the next
    movement. Swapping the index and re-showing on the SAME tick is deliberate —
    the leaving item is already at opacity zero by then, so the incoming one
    fades up from an empty card rather than cross-fading over its predecessor.
  */
  React.useEffect(() => {
    if (dismissed || items.length === 0) return;

    /*
      Hovering or focusing holds the current movement on screen. The timers are
      torn down rather than paused, so releasing the pointer starts a fresh five
      seconds instead of resuming a partly elapsed one — somebody who has just
      begun reading gets the whole window.
    */
    if (paused) {
      setShown(true);
      return;
    }

    const leave = window.setTimeout(() => setShown(false), VISIBLE_MS);
    const advance = window.setTimeout(
      () => {
        setIndex((current) => current + 1);
        setShown(true);
      },
      VISIBLE_MS + FADE_MS + GAP_MS,
    );

    return () => {
      window.clearTimeout(leave);
      window.clearTimeout(advance);
    };
  }, [dismissed, paused, index, items.length]);

  const dismiss = React.useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Nothing to do — the in-memory dismissal above is already applied.
    }
  }, []);

  if (dismissed || items.length === 0) return null;

  // Wraps rather than resetting, so the animation never runs backwards.
  const item = items[index % items.length];
  const isDeposit = item.kind === "DEPOSIT";

  /*
    The two kinds are told apart by colour AND by icon AND by verb, never by
    colour alone: this is a money surface, and emeraldBrand is the one colour on
    it that means "money in" (see the token comment in tailwind.config.ts). A
    withdrawal shown in the deposit colour would be a genuinely dangerous
    ambiguity, so the distinction has to survive a colourblind reader.
  */
  const tone = isDeposit
    ? {
        frame: "border-emeraldBrand-500/35",
        icon: "bg-emeraldBrand-500/15 text-emeraldBrand-600 dark:text-emeraldBrand-400",
        verb: "text-emeraldBrand-600 dark:text-emeraldBrand-400",
      }
    : {
        frame: "border-amber-500/35",
        icon: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
        verb: "text-amber-600 dark:text-amber-400",
      };

  return (
    <div
      /*
        Top centre, pinned below the shell's own chrome rather than over it: the
        mobile header is h-14 and the desktop one h-16, both `sticky top-0`, so
        4.5rem/5rem clears each with a 1rem gap. Nothing overlaps the
        navigation, which is the one thing a fixed top overlay gets wrong.

        `lg:left-[calc(50%_+_9rem)]` recentres over the CONTENT column: the
        shell pads itself by the 18rem sidebar, so a viewport-centred box would
        sit half a sidebar to the left of what it is talking about.

        `aria-live` is deliberately OFF: a status region that reannounces every
        five seconds makes the page unusable with a screen reader, and this is
        ambient information, not an announcement.
      */
      aria-live="off"
      /*
        `!mt-0` is load-bearing, not decoration. The dashboard renders this
        inside a `space-y-6` column, whose sibling rule is `margin-top` with a
        specificity no plain utility can beat — so without the important flag the
        popup sits 24px lower than `top` says, and its position depends on a
        container it is not supposed to care about. A fixed overlay should place
        itself, not inherit a spacing decision from the flow it escapes.
      */
      className="pointer-events-none !mt-0 fixed left-1/2 top-[4.5rem] z-50 w-[min(26rem,calc(100vw-1.5rem))] -translate-x-1/2 sm:top-[5rem] lg:left-[calc(50%_+_9rem)]"
    >
      <div
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
        aria-hidden={!shown}
        className={cn(
          "flex items-center gap-3 rounded-2xl border bg-card/95 p-3 shadow-xl backdrop-blur-md",
          // A transition, not a keyframe animation: a transition has a resting
          // state at both ends, so the card can sit hidden through the gap
          // without any fill-mode trickery to keep it there.
          "transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none",
          shown
            ? "pointer-events-auto translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-3 opacity-0",
          tone.frame,
        )}
      >
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
            tone.icon,
          )}
          aria-hidden
        >
          {isDeposit ? (
            <ArrowDownToLine className="h-4 w-4" />
          ) : (
            <ArrowUpFromLine className="h-4 w-4" />
          )}
        </span>

        {/*
          One line when there is room, wrapping to two on a narrow phone — which
          is why this is not `truncate` at every width. Truncating here would cut
          the elapsed time off the end, and the time is the part that says the
          activity is recent.
        */}
        <p className="min-w-0 flex-1 text-sm leading-snug sm:truncate">
          <span className="font-semibold">{item.displayName}</span>{" "}
          <span className={tone.verb}>{isDeposit ? "deposited" : "withdrew"}</span>{" "}
          <span className="font-bold tabular-nums">
            {formatMoney(item.amount, item.currency, { decimals: 0 })}
          </span>{" "}
          <span className="text-muted-foreground">· {relativeTimeWords(item.at)}</span>
        </p>

        {/*
          Rendered only while visible: a button at opacity zero is still
          reachable by keyboard and still in the accessibility tree, and tabbing
          into an invisible control is worse than not having one.
        */}
        {shown ? (
          <button
            type="button"
            onClick={dismiss}
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary"
            aria-label="Hide activity updates"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
