"use client";

import * as React from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * PWA wiring: service-worker registration and the install prompt.
 *
 * `public/sw.js` existed but was never registered, so the offline shell was dead
 * code and the app was not installable. This connects it.
 *
 * Registration is PRODUCTION-ONLY, deliberately. The worker caches
 * `/_next/static` cache-first, which is correct for immutable production chunks
 * and dangerous in development, where the same paths are rewritten on every
 * edit — a cache-first hit there serves stale JavaScript and produces hydration
 * errors that look like unrelated bugs. `next dev` also already ships its own
 * hot-reload machinery. The cost is that offline behaviour cannot be exercised
 * with `npm run dev`; verify it with `npm run build && npm run start`.
 *
 * The worker itself never caches balances, dashboard HTML, `/api/*`, `/login`
 * or `/register` — a stale cached balance would be a correctness bug, not a
 * performance win.
 */

const DISMISS_KEY = "taskcash.pwa.install-dismissed";

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice?: Promise<unknown> };

export function Pwa() {
  const [installEvent, setInstallEvent] = React.useState<InstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = React.useState(true);

  // Register the service worker (production only — see the note above).
  React.useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      void navigator.serviceWorker.register("/sw.js").catch(() => {
        // Registration failure is not fatal: the app works online without it.
      });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register);

    return () => window.removeEventListener("load", register);
  }, []);

  React.useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }

    function onPrompt(event: Event) {
      // Chrome fires this instead of showing its own UI. Preventing the default
      // keeps the decision with the user rather than interrupting them.
      event.preventDefault();
      setInstallEvent(event as InstallPromptEvent);
    }

    function onInstalled() {
      setInstallEvent(null);
      setDismissed(true);
    }

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (dismissed || !installEvent) return null;

  async function install() {
    // Narrowed here rather than relying on the render-time guard above: the
    // closure does not inherit that narrowing, and the event can be cleared by
    // an `appinstalled` event between render and click.
    const event = installEvent;
    if (!event) return;

    setInstallEvent(null);
    try {
      await event.prompt();
    } catch {
      // The user dismissed the native sheet — nothing to report.
    }
  }

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Ignore — hiding it for this view is still correct.
    }
    setDismissed(true);
  }

  return (
    <div
      role="region"
      aria-label="Install TaskCash Pro"
      className="fixed inset-x-3 bottom-24 z-50 rounded-2xl border border-border bg-card p-4 shadow-lg lg:bottom-6 lg:right-6 lg:left-auto lg:w-96"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Download className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Install TaskCash Pro</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Add it to your home screen for a full-screen app that opens faster. You will still sign in
            normally, and your balance is always read from our servers.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={install}>
              Install
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss}>
              Not now
            </Button>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss the install suggestion"
          className="rounded-full p-1 text-muted-foreground hover:bg-secondary"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
