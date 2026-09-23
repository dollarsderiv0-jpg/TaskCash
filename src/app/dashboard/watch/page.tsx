import type { Metadata } from "next";
import Link from "next/link";
import { Coins, Info, Lock, PlayCircle, Receipt, Video } from "lucide-react";
import { guardVerifiedPage } from "@/lib/auth/guards";
import { listAvailableVideos } from "@/server/services/videos";
import { listPackageCatalogue } from "@/server/services/packages";
import { getEarningsSummary } from "@/server/services/wallet";
import { toWatchListItem } from "@/lib/video/watch-item";
import { WatchList } from "@/components/app/watch-list";
import { PackagesCatalogue, PackagesUnavailable } from "@/components/app/packages-catalogue";
import { Alert, Badge, EmptyState } from "@/components/ui/misc";
import { formatMoney } from "@/lib/money/format";

export const metadata: Metadata = { title: "Watch & Earn" };

export const dynamic = "force-dynamic";

/**
 * Watch & Earn — the package catalogue, and the videos of a package you hold.
 *
 * WHY THIS PAGE IS PACKAGE-FIRST
 * ------------------------------
 * It used to render the flat video catalogue and nothing else. Every one of the
 * platform's 305 videos belongs to a package, so that list was, in practice, a
 * wall of cards the visitor could not earn from: opening any of them raises
 * PACKAGE_REQUIRED in the database. A page whose entire content is locked is not
 * a catalogue, it is a locked door with no handle.
 *
 * So the packages come first, and the videos appear only for a tier the viewer
 * actually holds — chosen with WATCH, which arrives here as `?package=<id>`.
 * That scoping is presentation only. The gate itself is `video_start` and
 * `video_complete_session`, which refuse a video whose package is not held, so a
 * hand-written URL cannot unlock anything.
 */
export default async function WatchPage({
  searchParams,
}: {
  searchParams: Promise<{ package?: string }>;
}) {
  const session = await guardVerifiedPage("/dashboard/watch");
  const params = await searchParams;

  const [catalogue, earnings] = await Promise.all([
    listPackageCatalogue(session.profile.id),
    getEarningsSummary(session.profile.id),
  ]);

  const currency = session.wallet.currency;

  /*
    Held packages are listed first. Someone who has already paid is looking for
    their videos, not for another offer, and making them scroll past nine tiers
    to reach the one they own is the page arguing with its own purpose.
  */
  const tiers = [...catalogue.packages].sort((a, b) => {
    const ownedDifference = Number(b.owned && !b.expired) - Number(a.owned && !a.expired);
    return ownedDifference !== 0 ? ownedDifference : a.sort_order - b.sort_order;
  });

  const held = tiers.filter((tier) => tier.owned && !tier.expired);
  const selected = params.package ? (tiers.find((tier) => tier.id === params.package) ?? null) : null;

  /*
    Videos are read only for a package this viewer holds and which has not
    lapsed: an unheld tier's videos would all render as locked cards, which is
    the wall this page exists to remove.
  */
  const openable = selected && selected.owned && !selected.expired ? selected : null;

  const packageVideos = openable
    ? await listAvailableVideos(session.profile.id, { packageId: openable.id, limit: 60 })
    : null;

  const items = (packageVideos?.items ?? []).map(toWatchListItem);
  const doneToday = items.filter((video) => video.rewardedToday > 0).length;

  /*
    Package earnings are summed from each package's own allowance, which the
    database derives from the wallet ledger. It is deliberately not today's total
    earnings: a referral bonus is earnings, and counting it here would credit it
    to a package that never paid it.
  */
  const packageEarnings = held.reduce((sum, tier) => sum + tier.earnedToday, 0);

  const daysLeft =
    openable?.expiresAt && !openable.expired
      ? Math.max(
          0,
          Math.ceil((new Date(openable.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
        )
      : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Watch &amp; Earn</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Activate a package, then earn from its videos. Every reward is credited only after our
          server verifies your watch time.
        </p>
      </div>

      {/* Earnings, straight from the wallet ledger and each package's own allowance. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          icon={Coins}
          label="Today's earnings"
          value={formatMoney(earnings.todayEarnings, currency)}
          hint="Rewards credited today"
          tone="success"
        />
        <StatTile
          icon={Receipt}
          label="Package earnings"
          value={formatMoney(packageEarnings, currency)}
          hint={held.length > 0 ? `From ${held.length} active package${held.length === 1 ? "" : "s"}` : "No active packages"}
        />
        <StatTile
          icon={Video}
          label="Videos completed"
          value={String(earnings.videosCompleted)}
          hint="Rewarded watch sessions"
        />
      </div>

      <Alert variant="info" title="How verification works">
        <p>
          The timer is measured on our servers against real elapsed time, so progress cannot be
          inflated. Each session can only be rewarded once, and each package has its own daily and
          total limits.
        </p>
      </Alert>

      {/*
        A package was asked for that this viewer cannot open. Said out loud rather
        than silently showing nothing, because the alternative — an empty section
        under a heading that promises videos — reads as a broken page.
      */}
      {selected && !openable ? (
        <Alert variant="warning" title={`${selected.name} is not active`}>
          <p>
            {selected.expired
              ? "This package's earning period has ended, so its videos no longer pay. Activating it again starts a new period and a new allowance."
              : "Its videos stay locked until the package is active. Choose it below to activate it."}
          </p>
        </Alert>
      ) : null}

      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">Packages</h2>
          <span className="text-xs text-muted-foreground">
            {tiers.length} available
          </span>
        </div>

        {!catalogue.available ? (
          <PackagesUnavailable />
        ) : (
          <PackagesCatalogue
            tiers={tiers}
            currency={currency}
            balance={Number(session.wallet.available_balance)}
            defaultPhone={session.profile.phone ?? ""}
            country={session.profile.country ?? "KE"}
          />
        )}
      </section>

      {/* The videos of the package the viewer chose — this package's, and only this one's. */}
      {openable ? (
        <section className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border pt-5">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                {openable.name}
                <Badge variant="success">Active</Badge>
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {daysLeft !== null
                  ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining`
                  : "No expiry"}
                {items.length > 0 ? ` · ${doneToday} of ${items.length} videos earned from today` : ""}
              </p>
            </div>
            <Link
              href="/dashboard/watch"
              className="text-xs font-semibold text-muted-foreground underline-offset-4 hover:underline"
            >
              All packages
            </Link>
          </div>

          <Alert variant="info" title="Available videos">
            <p>
              Only this package&apos;s videos are listed. Each one pays the reward shown beside it —
              amounts differ per video and per package, and a reward is credited only while its
              campaign still has budget.
            </p>
          </Alert>

          {items.length === 0 ? (
            <EmptyState
              icon={PlayCircle}
              title="No videos available from this package right now"
              description="Its videos will appear here as soon as an administrator publishes active campaigns for them."
            />
          ) : (
            <WatchList
              videos={items}
              currency={currency}
              total={packageVideos?.total ?? items.length}
              packageId={openable.id}
            />
          )}
        </section>
      ) : null}

      {held.length === 0 && catalogue.available ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          Package videos stay locked until the package is active. Rewards are paid out of each
          campaign&apos;s own budget, and a package buys access to platform services rather than a
          guaranteed return.
        </p>
      ) : null}

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Info className="h-3.5 w-3.5" aria-hidden />
        A payment activates a package only after the provider confirms it. A failed, cancelled or
        pending payment leaves the package inactive.
      </p>
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint: string;
  tone?: "default" | "success";
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon
          className={tone === "success" ? "h-3.5 w-3.5 text-emeraldBrand-500" : "h-3.5 w-3.5"}
          aria-hidden
        />
        {label}
      </p>
      <p className="mt-1.5 text-xl font-bold tracking-tight tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
