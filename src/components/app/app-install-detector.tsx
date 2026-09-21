"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "@/lib/client/api";

/**
 * Records that this account has the app on this device.
 *
 * Renders nothing and cannot be seen or tapped — it is the quiet half of the
 * install page's instructions. Two signals are watched, both of which are only
 * reachable from a real install:
 *
 *   · `display-mode: standalone` (or iOS's `navigator.standalone`) — how a page
 *     launched from the home-screen icon reports itself. A browser tab opened
 *     from a link is never standalone, so this cannot be faked by visiting the
 *     install page.
 *   · the browser's `appinstalled` event, which fires for the origin the moment
 *     the install completes.
 *
 * The report is idempotent server-side and the column is stamped once, so the
 * worst a repeat can do is append another audit row. A refresh follows the first
 * successful record of a session so the page the user is looking at — the wallet
 * screen in particular — is re-rendered by the server with the app now known.
 *
 * It never reports on failure and never blocks rendering: a missing migration
 * means "not recorded", which hides the limits and breaks nothing.
 */
export function AppInstallDetector() {
  const router = useRouter();

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const KEY = "taskcash.app-install-reported";

    const isStandalone = () =>
      window.matchMedia?.("(display-mode: standalone)").matches === true ||
      (window.navigator as { standalone?: boolean }).standalone === true ||
      document.referrer.startsWith("android-app://");

    async function report(source: "STANDALONE" | "APPINSTALLED") {
      try {
        if (window.sessionStorage.getItem(KEY) === "1") return;
        const response = await apiRequest<{ recorded: boolean }>("/api/app/install", {
          method: "POST",
          body: { source },
        });
        window.sessionStorage.setItem(KEY, "1");
        // Only a first-time record changes what the server renders.
        if (response.ok && response.data.recorded) router.refresh();
      } catch {
        /* not recorded is an acceptable outcome — the limits simply stay hidden */
      }
    }

    if (isStandalone()) {
      void report("STANDALONE");
    }

    const onInstalled = () => void report("APPINSTALLED");
    window.addEventListener("appinstalled", onInstalled);
    return () => window.removeEventListener("appinstalled", onInstalled);
  }, [router]);

  return null;
}
