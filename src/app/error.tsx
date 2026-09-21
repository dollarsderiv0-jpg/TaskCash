"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, LifeBuoy, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Application error boundary.
 *
 * Users never see a stack trace or a raw provider message. They get one calm
 * sentence, a way to retry, and a short reference they can quote to support.
 * The digest is the only thing Next.js gives us in production that can be
 * correlated with the server log entry for the same failure.
 *
 * The underlying message is shown *only* outside production, where it belongs
 * to the developer wiring up the environment.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const isProduction = process.env.NODE_ENV === "production";

  React.useEffect(() => {
    // Structured enough for log aggregation: one line per failure.
    console.error(
      JSON.stringify({
        level: "error",
        scope: "app-error-boundary",
        digest: error.digest ?? null,
        name: error.name,
        message: error.message,
      }),
    );
  }, [error]);

  return (
    <div className="container flex min-h-[70dvh] items-center justify-center py-16">
      <Card className="w-full max-w-lg">
        <CardContent className="flex flex-col items-center gap-4 p-6 text-center sm:p-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
          </div>

          <h1 className="text-xl font-bold tracking-tight">Something went wrong</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Something went wrong. Please try again. If it keeps happening, contact support and quote
            the reference below.
          </p>

          {error.digest ? (
            <p className="rounded-lg border border-border bg-secondary/50 px-3 py-1.5 font-mono text-xs text-muted-foreground">
              Reference: {error.digest}
            </p>
          ) : null}

          {!isProduction ? (
            <pre className="max-h-40 w-full overflow-auto rounded-lg border border-dashed border-border bg-secondary/40 p-3 text-left text-[11px] leading-relaxed text-muted-foreground">
              {error.name}: {error.message}
            </pre>
          ) : null}

          <div className="mt-1 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
            <Button onClick={reset} className="sm:w-auto">
              <RefreshCw aria-hidden />
              Try again
            </Button>
            <Button asChild variant="outline" className="sm:w-auto">
              <Link href="/contact">
                <LifeBuoy aria-hidden />
                Contact support
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
