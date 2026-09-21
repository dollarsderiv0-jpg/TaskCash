import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";

/**
 * Shown while the dashboard's server data is being read.
 *
 * Next.js renders this during the server round trip, so a slow connection shows
 * a recognisable layout with a sentence saying what is happening, instead of a
 * blank screen that looks like a failure.
 *
 * The skeleton is deliberately shape-only: it must NOT contain numbers. A
 * placeholder `KES 0.00` would be a fabricated balance — the exact thing this
 * application must never show, even for a moment.
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <p className="text-sm text-muted-foreground">Preparing your dashboard…</p>
      </div>

      <Card>
        <CardContent className="grid gap-6 p-5 sm:grid-cols-2">
          <div>
            <Skeleton className="h-3 w-32" />
            <Skeleton className="mt-3 h-10 w-44" />
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-4 w-24" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-4 w-24" />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:border-l sm:border-border sm:pl-6">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="space-y-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-6 w-20" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-20 rounded-xl" />
        ))}
      </div>

      <Card>
        <CardContent className="space-y-3 p-5">
          <p className="text-sm text-muted-foreground">Loading your recent activity…</p>
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="flex items-center justify-between gap-4">
              <div className="space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
