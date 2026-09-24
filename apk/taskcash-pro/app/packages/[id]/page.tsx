"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowRight, Clock3 } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { PrimaryButton } from "@/components/primary-button";
import { buttonStyles } from "@/components/primary-button";
import { StatusBadge } from "@/components/status-badge";
import { useToast } from "@/components/toast";
import { formatCountdown, formatMoneyCompact } from "@/lib/format";
import { getPackage, tasksForPackage } from "@/lib/mock-data";
import { useStore } from "@/lib/store";

export default function PackageDetailPage() {
  const params = useParams<{ id: string }>();
  const tier = getPackage(params?.id);
  const { activePackages, activatePackage } = useStore();
  const toast = useToast();

  /**
   * The countdown is deliberately client-only. Rendering a live clock during SSR
   * would make the server markup and the first client paint disagree, so it
   * fills in once mounted.
   */
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!tier) {
    return (
      <AppShell>
        <PageHeader title="Package not found" backHref="/packages" />
        <div className="tc-card px-5 py-10 text-center">
          <p className="text-sm text-muted">That package id does not exist in the catalogue.</p>
          <Link
            href="/packages"
            className={buttonStyles({ variant: "flame", size: "md", className: "mt-4" })}
          >
            Back to packages
          </Link>
        </div>
      </AppShell>
    );
  }

  const owned = activePackages.find((p) => p.packageId === tier.id);
  const isActive = Boolean(owned);
  const tasks = tasksForPackage(tier.id);

  const remainingMs = owned && now !== null ? new Date(owned.expiresAt).getTime() - now : null;

  const handleActivate = () => {
    const result = activatePackage(tier.id);
    if (!result.ok) {
      toast.error("Could not activate", result.message);
      return;
    }
    toast.success(`${tier.name} activated`, "Its daily tasks are now unlocked in Watch & Earn.");
  };

  return (
    <AppShell>
      <PageHeader
        title={tier.name}
        subtitle="Rate per task, daily earnings and the earning window for this tier."
        backHref="/packages"
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
        {/* The reference card. */}
        <section className="tc-card p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <p className="tc-value text-3xl sm:text-4xl">{formatMoneyCompact(tier.price)}</p>
            <StatusBadge tone={isActive ? "active" : "inactive"} dot={isActive}>
              {isActive ? "Active" : "Not active"}
            </StatusBadge>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-tile border border-hairline bg-base/50 p-3">
              <p className="tc-label">Duration</p>
              <p className="tc-value mt-1 text-xl">{tier.days} Days</p>
            </div>
            <div className="rounded-tile border border-hairline bg-base/50 p-3">
              <p className="tc-label">Total payout</p>
              <p className="tc-value mt-1 text-xl text-brand-400">
                {formatMoneyCompact(tier.totalReturn)}
              </p>
            </div>
          </div>

          <div className="mt-4 rounded-tile border border-hairline bg-base/50 px-3.5 py-1">
            <div className="tc-row">
              <span className="tc-row-label">Rate per Video</span>
              <span className="tc-row-value">{formatMoneyCompact(tier.taskCost)}</span>
            </div>
            <div className="tc-row">
              <span className="tc-row-label">Daily Earnings</span>
              <span className="tc-row-value">{formatMoneyCompact(tier.dailyEarnings)} / day</span>
            </div>
            <div className="tc-row">
              <span className="tc-row-label">Number of Videos</span>
              <span className="tc-row-value">{tier.tasksPerDay} Videos / day</span>
            </div>
            <div className="tc-row">
              <span className="tc-row-label">Countdown / Status</span>
              <span className={isActive ? "tc-row-value text-cash" : "tc-row-value text-muted"}>
                {!isActive
                  ? "Not activated"
                  : remainingMs === null
                    ? "—"
                    : formatCountdown(remainingMs)}
              </span>
            </div>
            <div className="tc-row">
              <span className="tc-row-label">Net profit</span>
              <span className="tc-row-value text-cash">
                +{formatMoneyCompact(tier.netProfit)} ({tier.netReturnPct}%)
              </span>
            </div>
          </div>

          <div className="mt-4">
            {isActive ? (
              <Link href="/watch" className={buttonStyles({ variant: "brand", size: "lg", full: true })}>
                Go to Watch &amp; Earn
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            ) : (
              <PrimaryButton variant="brand" size="lg" full onClick={handleActivate}>
                Activate Package
              </PrimaryButton>
            )}
          </div>

          <p className="mt-2.5 text-center text-[10px] leading-snug text-muted/80">
            Activation is simulated from your mock wallet balance. Projected returns are a maximum,
            not a promise.
          </p>
        </section>

        {/* Tasks belonging to this tier. */}
        <section className="tc-card p-4" aria-labelledby="tier-videos">
          <h2 id="tier-videos" className="text-[15px] font-bold tracking-tight text-white">
            Available videos
          </h2>
          <p className="mt-0.5 text-[11px] text-muted">
            {isActive
              ? `${tier.name} is active — these rewards are claimable.`
              : `Locked until ${tier.name} is activated.`}
          </p>

          <ul className="mt-3 space-y-2">
            {tasks.length === 0 ? (
              <li className="rounded-tile border border-hairline bg-base/40 px-3.5 py-6 text-center text-[11px] text-muted">
                No tasks are attached to this tier yet.
              </li>
            ) : (
              tasks.map((task, index) => (
                <li
                  key={task.id}
                  className="flex items-center justify-between gap-3 rounded-tile border border-hairline bg-base/40 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[12px] font-semibold text-white">
                      Video {index + 1} — {task.videoLabel}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                      <Clock3 className="h-3 w-3" aria-hidden />
                      {task.durationSeconds}s
                      <span className="text-hairline">•</span>
                      <span className="tnum font-semibold text-cash">
                        Reward: {formatMoneyCompact(task.reward)}
                      </span>
                    </p>
                  </div>
                  {isActive ? (
                    <Link
                      href="/watch"
                      className={buttonStyles({ variant: "outline", size: "sm", className: "shrink-0" })}
                    >
                      Watch
                    </Link>
                  ) : (
                    <StatusBadge tone="inactive" className="shrink-0">
                      Locked
                    </StatusBadge>
                  )}
                </li>
              ))
            )}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
