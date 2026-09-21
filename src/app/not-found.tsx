import Link from "next/link";
import type { Metadata } from "next";
import { Compass, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <div className="container flex min-h-[70dvh] items-center justify-center py-16">
      <Card className="w-full max-w-lg">
        <CardContent className="flex flex-col items-center gap-4 p-6 text-center sm:p-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
            <Compass className="h-5 w-5 text-muted-foreground" aria-hidden />
          </div>

          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">404</p>
          <h1 className="text-xl font-bold tracking-tight">This page could not be found</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            The link may be out of date, or the page may have been moved. Your wallet and account are
            unaffected.
          </p>

          <div className="mt-1 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
            <Button asChild className="sm:w-auto">
              <Link href="/dashboard">
                <Home aria-hidden />
                Go to dashboard
              </Link>
            </Button>
            <Button asChild variant="outline" className="sm:w-auto">
              <Link href="/">Back to home</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
