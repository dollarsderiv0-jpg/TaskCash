import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";

/** Shown while available activities are read. Names what is being waited on. */
export default function WatchLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <Skeleton className="h-7 w-44" />
        <p className="text-sm text-muted-foreground">Checking available tasks…</p>
      </div>

      <div className="space-y-4">
        {[0, 1, 2].map((index) => (
          <Card key={index}>
            <CardContent className="flex gap-4 p-4">
              <Skeleton className="h-20 w-32 shrink-0 rounded-lg" />
              <div className="flex-1 space-y-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-9 w-32 rounded-md" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
