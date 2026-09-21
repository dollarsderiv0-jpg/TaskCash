"use client";

import * as React from "react";

/**
 * Counts down to an instant, for display only.
 *
 * This is a clock, not a rule. What it counts down to — the moment a package's
 * daily allowance comes back — is decided by the database against the operator's
 * midnight, and the reward gate re-checks it server-side. A device whose clock is
 * wrong, or a tab whose timers are throttled, can therefore make this number
 * wrong but cannot earn a single extra shilling from it.
 *
 * Shared by the packages page and the watch list so the two never disagree about
 * how much time is left.
 */
export function useCountdown(target: string | null | undefined): string | null {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!target) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [target]);

  if (!target) return null;

  const remainingMs = new Date(target).getTime() - now;
  if (!Number.isFinite(remainingMs)) return null;
  if (remainingMs <= 0) return "Resetting now…";

  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");

  return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}
