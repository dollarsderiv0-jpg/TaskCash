"use client";

import * as React from "react";
import { Clock, Package as PackageIcon, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, Badge } from "@/components/ui/misc";
import { WatchPlayer } from "@/components/app/watch-player";
import { useCountdown } from "@/lib/client/use-countdown";
import { apiRequest } from "@/lib/client/api";
import { formatMoney } from "@/lib/money/format";
import { toWatchListItem, type WatchCardSource, type WatchListItem } from "@/lib/video/watch-item";

/**
 * The video's package context (migration 0014). `null` means the video is free to
 * watch as it always was.
 *
 * The item and package shapes live in `@/lib/video/watch-item` because the
 * server renders the first page and this component appends later ones — both
 * sides must map a card identically or the second page would differ from the
 * first.
 */
export type { WatchListItem, WatchListPackage } from "@/lib/video/watch-item";

/**
 * The package's remaining daily allowance, ticking down to the reset.
 *
 * Shown whenever the user HOLDS the package — not only when the allowance is
 * spent — because "how much is left today" is the question that decides whether
 * it is worth watching another video, and answering it only after the cap is hit
 * is answering it too late.
 */
function PackageAllowance({ info, currency }: { info: NonNullable<WatchListItem["package"]>; currency: string }) {
  const countdown = useCountdown(info.resetsAt);
  if (!info.owned || info.dailyCap <= 0) return null;

  const left = Math.max(0, info.dailyCap - info.earnedToday);

  return (
    <p className="mt-1.5 text-xs text-muted-foreground">
      {info.name}: {formatMoney(left, currency)} of {formatMoney(info.dailyCap, currency)} left today
      {countdown ? ` · resets in ${countdown}` : ""}
    </p>
  );
}

/**
 * The catalogue.
 *
 * The first page arrives already rendered by the server; everything after it is
 * fetched on demand. That is deliberate — the whole catalogue used to be
 * serialized into the page and rendered as cards, so 305 videos meant roughly
 * 150KB of flight payload and 305 cards of DOM before the user saw anything.
 * Now the cost is proportional to what is on screen, and the total is known so
 * the button can say how much is left rather than guessing.
 */
export function WatchList({
  videos,
  currency,
  total,
  packageId = null,
}: {
  videos: WatchListItem[];
  currency: string;
  total: number;
  /**
   * Set when the list is showing ONE package's videos.
   *
   * Passed to the paging request as well as used for display: without it, "show
   * more" would append videos from the whole catalogue underneath a heading that
   * names a single package.
   */
  packageId?: string | null;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [extra, setExtra] = React.useState<WatchListItem[]>([]);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [knownTotal, setKnownTotal] = React.useState(total);

  /*
    Later pages are kept separate from the server-rendered first page instead of
    merged into state, so a server refresh (which happens after a reward is
    collected) cannot be overwritten by a stale client copy. Deduplicating on id
    means a video that moves between pages — because eligibility changed what the
    first page contains — is not drawn twice.
  */
  const items = React.useMemo(() => {
    const seen = new Set(videos.map((video) => video.id));
    return [...videos, ...extra.filter((video) => !seen.has(video.id))];
  }, [videos, extra]);

  const selected = items.find((video) => video.id === selectedId) ?? null;
  const remaining = Math.max(0, knownTotal - items.length);

  async function loadMore() {
    setLoadingMore(true);
    setLoadError(null);

    // No limit is sent: the server applies its own page size, so this component
    // can never widen the page and re-create the payload problem it exists to fix.
    const query = new URLSearchParams({ offset: String(items.length) });
    if (packageId) query.set("packageId", packageId);

    const response = await apiRequest<{ videos: WatchCardSource[]; total: number }>(
      `/api/videos?${query.toString()}`,
    );

    setLoadingMore(false);

    if (!response.ok) {
      setLoadError(response.message);
      return;
    }

    /*
      The API returns the service's own cards — the same rows the server page
      receives — so they are mapped through the same helper here. That is the
      point of the shared module: a page of cards fetched here renders
      identically to the first page rendered on the server.
    */
    setKnownTotal(response.data.total);
    setExtra((previous) => [...previous, ...response.data.videos.map(toWatchListItem)]);
  }

  if (selected) {
    return (
      <div className="space-y-5">
        <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
          ← Back to all campaigns
        </Button>
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-2">
              {selected.campaignName ? <Badge variant="info">{selected.campaignName}</Badge> : null}
              <Badge variant="default">
                <Clock className="h-3 w-3" aria-hidden />
                {Math.round(selected.durationSeconds)}s
              </Badge>
              <Badge variant="success">
                +{formatMoney(selected.rewardAmount, currency)} reward
              </Badge>
            </div>
            <h2 className="text-lg font-semibold tracking-tight">{selected.title}</h2>
            {selected.description ? (
              <p className="text-sm leading-relaxed text-muted-foreground">{selected.description}</p>
            ) : null}
            <WatchPlayer
              video={{
                id: selected.id,
                title: selected.title,
                description: selected.description,
                videoUrl: selected.videoUrl,
                rewardAmount: selected.rewardAmount,
                durationSeconds: selected.durationSeconds,
                requiredWatchSeconds: selected.requiredWatchSeconds,
                thumbnailUrl: selected.thumbnailUrl,
                campaignName: selected.campaignName,
              }}
              currency={currency}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-4">
        {items.map((video) => (
          <li key={video.id}>
            <Card className="transition-shadow hover:shadow-md">
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {video.campaignName ? <Badge variant="info">{video.campaignName}</Badge> : null}
                      {video.package ? (
                        <Badge variant={video.package.owned ? "success" : "outline"}>
                          <PackageIcon className="h-3 w-3" aria-hidden />
                          {video.package.name}
                          {video.package.owned ? "" : " · not active"}
                        </Badge>
                      ) : null}
                      <Badge variant="default">
                        <Clock className="h-3 w-3" aria-hidden />
                        {Math.round(video.durationSeconds)}s
                      </Badge>
                      {video.eligible ? (
                        video.remainingToday > 0 ? (
                          <Badge variant="success">{video.remainingToday} left today</Badge>
                        ) : null
                      ) : (
                        <Badge variant="warning">Not available</Badge>
                      )}
                    </div>

                    <h3 className="mt-2 font-semibold leading-snug">{video.title}</h3>
                    {video.description ? (
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        {video.description}
                      </p>
                    ) : null}

                    <p className="mt-2 text-xs text-muted-foreground">
                      Requires {Math.round(video.requiredWatchSeconds)}s of verified watch time
                      {video.rewardedToday > 0 ? ` · completed ${video.rewardedToday} time(s) today` : ""}
                    </p>

                    {video.package ? (
                      <PackageAllowance info={video.package} currency={currency} />
                    ) : null}

                    {!video.eligible && video.reason ? (
                      <p className="mt-2 text-xs font-medium text-amber-600 dark:text-amber-400">
                        {video.reason}
                      </p>
                    ) : null}
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-lg font-bold tc-amount-in">
                      +{formatMoney(video.rewardAmount, currency)}
                    </p>
                    <Button
                      size="sm"
                      className="mt-2"
                      disabled={!video.eligible}
                      onClick={() => setSelectedId(video.id)}
                    >
                      <PlayCircle className="h-4 w-4" aria-hidden />
                      {video.eligible ? "Watch now" : "Unavailable"}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      {loadError ? (
        <Alert variant="destructive" title="Could not load more videos">
          <p>{loadError}</p>
        </Alert>
      ) : null}

      {remaining > 0 ? (
        <div className="flex justify-center pt-1">
          <Button variant="outline" onClick={loadMore} loading={loadingMore}>
            {loadingMore ? "Loading more videos…" : `Show more videos (${remaining} remaining)`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
