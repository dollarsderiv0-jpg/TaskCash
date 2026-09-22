"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/**
 * Carries the logo screen on to the sign-up form.
 *
 * The delay is the point of the screen: the brand mark is what a visitor sees
 * the instant the link opens, and it needs to be on screen long enough to read
 * rather than flashing. Kept short enough that nobody waits for it.
 *
 * `replace`, not `push`: a splash screen is not somewhere the back button should
 * ever return to. Somebody who presses back from the form belongs on whatever
 * they were looking at before the link, not on a page that would bounce them
 * forward again.
 */
export function FrontDoorRedirect({ to, delayMs = 900 }: { to: string; delayMs?: number }) {
  const router = useRouter();

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      router.replace(to);
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [router, to, delayMs]);

  return null;
}
