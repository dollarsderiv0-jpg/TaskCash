"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { COMPANY_IMAGES_HEADING } from "@/content/company-images";
import type { PublicCompanyImage } from "@/server/services/company-images";

/**
 * The company pictures as a slideshow, at the top of the dashboard.
 *
 * A client component because it holds a timer — the only stateful part of this
 * feature. The list itself is fetched on the server and passed in, so the pictures
 * exist in the first paint and there is no request-on-mount flash.
 *
 * Three things it deliberately does NOT do:
 *
 *   - It does not autoplay for someone who asked for reduced motion. The
 *     preference is read from the media query and re-read when it changes, so
 *     turning it on mid-session stops the rotation instead of waiting for a
 *     reload.
 *   - It does not keep rotating under the pointer or the keyboard. Hovering or
 *     focusing holds the current picture, which is what makes the previous/next
 *     controls usable at all — otherwise the slide you are trying to read moves
 *     out from under you. Holding it is a genuine PAUSE: the time the picture has
 *     left is kept and resumed, never re-issued (see INTERVAL_MS).
 *   - It does not crop. `object-contain` on a fixed-height band, for the same
 *     reason the grid uses it: one of these pictures is a tall portrait logo, and
 *     filling a wide frame would cut the brand in half.
 */

/**
 * 5s of *visible* time per picture. Enough to read a caption, short enough not
 * to feel stuck.
 *
 * The rotation counts down the visible time left rather than leaning on a bare
 * interval, because the obvious implementation made the pause a reset: tearing an
 * interval down on hover and building a fresh one on leave handed the picture a
 * brand new 5 seconds every time the pointer drifted across the card, so the
 * rotation kept restarting instead of advancing. Only the time genuinely spent
 * waiting is deducted here, so leaving the card continues where the pause left
 * off.
 */
const INTERVAL_MS = 5000;

export function CompanySlideshow({ images }: { images: PublicCompanyImage[] }) {
  const [index, setIndex] = React.useState(0);
  const [paused, setPaused] = React.useState(false);
  const [reducedMotion, setReducedMotion] = React.useState(false);

  /**
   * How much visible time the current picture has left. A ref, not state: it
   * changes on every pause and resume and none of those is a reason to re-render.
   */
  const remainingRef = React.useRef(INTERVAL_MS);

  /**
   * True when the current picture was handed a fresh full interval by something
   * that is not a pause — the rotation advancing, or the user picking a picture
   * themselves. Only then is the countdown left alone; every other teardown is a
   * pause and freezes the remainder.
   */
  const freshRef = React.useRef(true);

  /** Bumped by the manual controls so the effect re-runs and reschedules. */
  const [restartToken, setRestartToken] = React.useState(0);

  /** Grants the next picture a full interval. Stable, so the effect below can
   *  depend on it without re-running on every render. */
  const handOff = React.useCallback(() => {
    remainingRef.current = INTERVAL_MS;
    freshRef.current = true;
  }, []);

  React.useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReducedMotion(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  /*
    One timeout per picture, rescheduled by `index` changing and by the manual
    controls bumping the token. Deliberately NOT a `setInterval`: an interval
    cannot express "wait only what is left of the current picture".
  */
  React.useEffect(() => {
    // One picture is not a slideshow; rotating it would be motion for nothing.
    if (paused || reducedMotion || images.length <= 1) return;

    const startedAt = Date.now();
    const timer = window.setTimeout(() => {
      // The next picture's interval starts when it appears, so it is handed a
      // full one before the state change that mounts it.
      handOff();
      setIndex((current) => (current + 1) % images.length);
    }, Math.max(0, remainingRef.current));

    return () => {
      window.clearTimeout(timer);

      if (freshRef.current) {
        // The interval was already granted on purpose — this teardown is the
        // advance itself, so there is no leftover to carry.
        freshRef.current = false;
        return;
      }

      // Every other teardown is a pause (or a list that changed under us), and a
      // pause keeps what was left instead of handing back a full interval. This
      // is the line that stops the rotation appearing to restart.
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt));
    };
  }, [paused, reducedMotion, images.length, index, restartToken, handOff]);

  // Keeps the index in range if the list ever shrinks under us — an admin hiding
  // a picture between two of these renders would otherwise leave a blank frame.
  const active = images.length > 0 ? index % images.length : 0;

  if (images.length === 0) return null;

  /*
    Manual navigation, deliberately separate from the rotation: a picture the user
    picked themselves gets a full interval to be read, so the controls do not fight
    the timer. `handOff` grants that interval, and bumping the token makes the
    pending timeout stand down instead of firing early against the old schedule —
    which also covers tapping the dot of the picture already on screen.
  */
  const goTo = (next: number) => {
    handOff();
    setIndex(((next % images.length) + images.length) % images.length);
    setRestartToken((token) => token + 1);
  };

  const step = (delta: number) => goTo(active + delta);

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Pictures of the companies behind TaskCash Pro"
      className="overflow-hidden rounded-2xl border border-border bg-card"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      {/*
        The label the pictures sit under, and the reason it is a constant in
        src/content/company-images.ts rather than a literal here: a heading of
        "Sponsored by" is a claim about a relationship, and the place to review
        that claim should not be buried in a component.
      */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Sparkles className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {COMPANY_IMAGES_HEADING}
        </p>
      </div>

      <div className="relative h-52 w-full bg-secondary/40 sm:h-64 lg:h-72">
        {images.map((image, i) => (
          <div
            key={image.id}
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${images.length}`}
            aria-hidden={i !== active}
            className={cn(
              "absolute inset-0 transition-opacity duration-700 motion-reduce:transition-none",
              i === active ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- operator-supplied, may be any host */}
            <img
              src={image.image_url}
              alt={image.name}
              loading={i === 0 ? "eager" : "lazy"}
              decoding="async"
              className="h-full w-full object-contain"
            />
          </div>
        ))}

        {images.length > 1 ? (
          <>
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label="Previous picture"
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full border border-border bg-background/80 p-2 text-foreground backdrop-blur transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label="Next picture"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full border border-border bg-background/80 p-2 text-foreground backdrop-blur transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
        {/*
          A live region rather than a visual counter: a screen reader is told which
          picture is showing, while the labels below stay a compact row of dots.
        */}
        <p aria-live="polite" className="truncate text-xs text-muted-foreground">
          <span className="sr-only">{`Picture ${active + 1} of ${images.length}: `}</span>
          {images[active].caption ?? images[active].name}
        </p>

        {images.length > 1 ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {images.map((image, i) => (
              <button
                key={image.id}
                type="button"
                onClick={() => goTo(i)}
                aria-label={`Show picture ${i + 1}`}
                aria-current={i === active}
                className={cn(
                  "h-1.5 rounded-full transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  i === active ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground",
                )}
              />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
