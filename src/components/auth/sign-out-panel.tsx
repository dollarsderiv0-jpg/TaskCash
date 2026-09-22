"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The sign-out screen.
 *
 * WHY THIS EXISTS
 * ---------------
 * Signing out used to push to `/`, and `/` now opens the brand mark and hands a
 * signed-out visitor to the sign-up form. So the last thing the platform did for
 * somebody who had just finished using it was invite them to register for an
 * account they already had. That is the shape of a bug report, so the session
 * now ends somewhere that says what happened.
 *
 * It also does the work rather than asking. The two menus that offer "Sign out"
 * are a decision already made — a confirmation step here would be the app asking
 * the same question twice.
 *
 * Ending a session is idempotent: arriving here already signed out is not an
 * error, so the panel resolves to the same screen either way.
 */
export function SignOutPanel() {
  const router = useRouter();
  const [state, setState] = React.useState<"working" | "done">("working");

  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        await fetch("/api/auth/logout", { method: "POST" });
      } catch {
        /*
          A failed request here is not worth a message. The session cookies are
          cleared server-side by the route; if it could not be reached, the next
          sign-in replaces them anyway, and telling somebody their sign-out
          "failed" would only make them try again.
        */
      }

      if (cancelled) return;
      setState("done");
      // Re-render the server tree so nothing cached still reflects the session.
      router.refresh();
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  const done = state === "done";

  /*
    One card, not two states of one card. Only the title changes with the
    outcome; the ways back in are in the markup from the first render.

    That matters because the sign-out is a client effect: a visitor with
    scripting unavailable never leaves the working state, and a panel that only
    renders its buttons once the request resolves would strand exactly the people
    who cannot run the request — on a screen that says nothing happened.
  */
  return (
    <Card>
      <CardHeader className="p-4 sm:p-5">
        <CardTitle className="flex items-center gap-2 text-base">
          {done ? (
            <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
          ) : (
            <LogOut className="h-4 w-4 text-muted-foreground" aria-hidden />
          )}
          <span role="status">{done ? "You have been signed out" : "Signing you out…"}</span>
        </CardTitle>
        <CardDescription className="text-xs">
          {done
            ? "This device has been signed out of TaskCash Pro."
            : "Ending the session on this device. This takes a moment."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0 sm:p-5 sm:pt-0">
        {/* The point nobody should have to guess at after a sign-out. */}
        <div className="flex gap-3 rounded-xl border border-border bg-secondary/40 p-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-[11px] leading-snug text-muted-foreground">
            Your wallet balance, ledger entries and any withdrawal request are unaffected — signing
            out only ends the session on this device.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Button asChild size="sm" className="w-full">
            <Link href="/login">Sign in again</Link>
          </Button>
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link href="/register">Create an account</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
