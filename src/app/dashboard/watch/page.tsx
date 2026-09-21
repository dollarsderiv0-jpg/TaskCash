import type { Metadata } from "next";
import { PlayCircle } from "lucide-react";
import { guardVerifiedPage } from "@/lib/auth/guards";
import { listAvailableVideos } from "@/server/services/videos";
import { toWatchListItem } from "@/lib/video/watch-item";
import { WatchList } from "@/components/app/watch-list";
import { Alert, EmptyState } from "@/components/ui/misc";

export const metadata: Metadata = { title: "Watch & Earn" };

export const dynamic = "force-dynamic";

export default async function WatchPage() {
  const session = await guardVerifiedPage("/dashboard/watch");

  /*
    One page, plus the total. The whole catalogue used to be fetched, serialized
    into this page and rendered as cards — for 305 videos that was ~150KB of
    payload and 305 cards before the user saw anything. The rest of the list is
    fetched on demand by WatchList.
  */
  const page = await listAvailableVideos(session.profile.id);
  const items = page.items.map(toWatchListItem);
  const currency = session.wallet.currency;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Watch &amp; Earn</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Complete a sponsored campaign and the reward is credited once our server verifies your
          watch time.
        </p>
      </div>

      <Alert variant="info" title="How verification works">
        <p>
          The timer is measured on our servers against real elapsed time, so progress cannot be
          inflated. Each session can only be rewarded once, and each campaign has its own daily
          limit and budget.
        </p>
      </Alert>

      {items.length === 0 ? (
        <EmptyState
          icon={PlayCircle}
          title="No videos available right now"
          description="New sponsored opportunities will appear here as soon as an administrator publishes an active campaign."
        />
      ) : (
        <WatchList videos={items} currency={currency} total={page.total} />
      )}
    </div>
  );
}
