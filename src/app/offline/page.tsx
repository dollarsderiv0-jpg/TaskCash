import type { Metadata } from "next";
import Link from "next/link";
import { WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "You are offline" };

export default function OfflinePage() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-secondary">
            <WifiOff className="h-6 w-6 text-muted-foreground" aria-hidden />
          </div>
          <CardTitle className="mt-3 text-xl">You are offline</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            TaskCash Pro needs a connection for anything involving your wallet. We do not cache
            balances or transaction data on your device, because a stale balance would be
            misleading.
          </p>
          <Button asChild className="w-full">
            <Link href="/dashboard">Try again</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
