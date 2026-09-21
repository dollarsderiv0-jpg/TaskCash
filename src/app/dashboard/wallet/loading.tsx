import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";

/**
 * Shown while the wallet is read.
 *
 * Says "Loading your wallet…" rather than leaving the page blank. No numbers
 * appear here — a placeholder balance would be a fabricated one, and a balance
 * is the single thing on this screen a user must be able to trust absolutely.
 */
export default function WalletLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <p className="text-sm text-muted-foreground">Loading your wallet…</p>
      </div>

      <Card>
        <CardContent className="grid gap-4 p-5 sm:grid-cols-3">
          {["Total", "Available", "Locked"].map((label) => (
            <div key={label} className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-28" />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-64" />
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">Loading transactions…</p>
          {[0, 1, 2, 3, 4].map((index) => (
            <div key={index} className="flex items-center justify-between gap-4">
              <div className="space-y-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
