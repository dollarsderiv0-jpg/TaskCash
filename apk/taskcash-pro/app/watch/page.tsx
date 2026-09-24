"use client";

import * as React from "react";
import Link from "next/link";
import { Flame, Lock, PlayCircle } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { TaskCard } from "@/components/task-card";
import { buttonStyles } from "@/components/primary-button";
import { useToast } from "@/components/toast";
import { formatMoneyCompact } from "@/lib/format";
import { PACKAGES, TASKS, getPackage } from "@/lib/mock-data";
import { useStore } from "@/lib/store";
import type { Task } from "@/lib/types";

export default function WatchPage() {
  const {
    state,
    activePackages,
    todayEarnings,
    packageEarnings,
    completedTaskCount,
    dailyQuota,
    quotaRemaining,
    claimTask,
  } = useStore();
  const toast = useToast();

  const ownedIds = activePackages.map((p) => p.packageId);
  const claimed = new Set(state.claimedTaskIds);
  const quotaUsed = dailyQuota > 0 && quotaRemaining === 0;

  /* Cheapest unowned tier, used for the upgrade prompt once the quota runs out. */
  const upgrade = PACKAGES.find((pkg) => !ownedIds.includes(pkg.id));

  const handleClaim = (task: Task) => {
    const result = claimTask(task.id);
    if (!result.ok) {
      toast.error("Reward not claimed", result.message);
      return;
    }
    toast.success(
      `${formatMoneyCompact(result.reward ?? task.reward)} credited`,
      "Added to your available balance.",
    );
  };

  return (
    <AppShell>
      <PageHeader
        title="Watch & Earn"
        subtitle="Watch the timed task, then claim the reward into your wallet."
        actions={
          <Link href="/packages" className={buttonStyles({ variant: "outline", size: "sm" })}>
            Packages
          </Link>
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Today's earnings" value={formatMoneyCompact(todayEarnings)} />
        <StatCard label="Package earnings" value={formatMoneyCompact(packageEarnings)} />
        <StatCard
          label="Videos completed"
          value={`${completedTaskCount} / ${TASKS.length}`}
        />
      </div>

      <section className="tc-card mt-3 p-4" aria-label="Daily task quota">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="tc-label">Daily task quota</p>
            <p className="tc-value mt-1 text-lg">
              {dailyQuota > 0 ? `${quotaRemaining} of ${dailyQuota} left` : "No active package"}
            </p>
          </div>
          <span
            className={
              quotaUsed
                ? "grid h-9 w-9 place-items-center rounded-tile border border-hairline bg-raised text-muted"
                : "grid h-9 w-9 place-items-center rounded-tile border border-hairline bg-raised text-flame-400"
            }
          >
            {quotaUsed ? <Lock className="h-4 w-4" aria-hidden /> : <Flame className="h-4 w-4" aria-hidden />}
          </span>
        </div>

        <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-base">
          <div
            className="h-full rounded-full bg-gradient-to-r from-flame to-flame-400 transition-[width] duration-500"
            style={{
              width: `${dailyQuota > 0 ? Math.min(100, ((dailyQuota - quotaRemaining) / dailyQuota) * 100) : 0}%`,
            }}
          />
        </div>
        <p className="mt-2 text-[11px] leading-snug text-muted">
          Quota is set by your highest active tier. Tasks from a tier you have not activated stay
          locked.
        </p>
      </section>

      {activePackages.length === 0 ? (
        <div className="tc-card mt-3 flex flex-col items-center gap-3 px-5 py-10 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full border border-hairline bg-raised text-flame-400">
            <PlayCircle className="h-6 w-6" aria-hidden />
          </span>
          <div>
            <p className="text-[15px] font-bold text-white">No tasks available yet</p>
            <p className="mx-auto mt-1 max-w-sm text-[12px] leading-snug text-muted">
              Activate a package to unlock its daily video tasks. Rewards are credited to your
              available balance the moment you claim them.
            </p>
          </div>
          <Link href="/packages" className={buttonStyles({ variant: "flame", size: "md" })}>
            Browse packages
          </Link>
        </div>
      ) : null}

      <section className="mt-4 space-y-3" aria-label="Available tasks">
        {TASKS.map((task) => {
          const tier = getPackage(task.packageId);
          const owned = ownedIds.includes(task.packageId);
          const isClaimed = claimed.has(task.id);
          const locked = !owned || (owned && quotaUsed && !isClaimed);

          const lockReason = !owned
            ? `Locked — requires ${tier?.name ?? "an active package"}.`
            : quotaUsed
              ? "Daily quota reached. Come back tomorrow."
              : undefined;

          return (
            <TaskCard
              key={task.id}
              task={task}
              claimed={isClaimed}
              locked={locked}
              lockReason={lockReason}
              onClaim={handleClaim}
            />
          );
        })}
      </section>

      {quotaUsed && upgrade ? (
        <section className="mt-4 flex flex-col items-start gap-3 rounded-card border border-flame/45 bg-gradient-to-r from-flame/[0.12] to-transparent p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[13px] font-bold text-white">
              Quota used for today — {upgrade.name} raises it
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted">
              Higher tiers allow up to {upgrade.tasksPerDay} tasks per day at{" "}
              {formatMoneyCompact(upgrade.taskCost)} each.
            </p>
          </div>
          <Link href="/packages" className={buttonStyles({ variant: "flame", size: "sm" })}>
            Upgrade
          </Link>
        </section>
      ) : null}
    </AppShell>
  );
}
