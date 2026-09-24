"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronRight,
  Package as PackageIcon,
  PlayCircle,
  ShieldCheck,
  Sparkles,
  Timer,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { BalanceCard } from "@/components/balance-card";
import { ComplianceDocuments } from "@/components/compliance-documents";
import { PackageCard } from "@/components/package-card";
import { PurchaseModal } from "@/components/purchase-modal";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { buttonStyles } from "@/components/primary-button";
import { formatCountdown, formatMoneyCompact } from "@/lib/format";
import { PACKAGES, getPackage } from "@/lib/mock-data";
import { useStore } from "@/lib/store";
import type { Package } from "@/lib/types";

const ACTIONS = [
  {
    href: "/watch",
    label: "Watch & Earn",
    hint: "Primary earning action",
    icon: PlayCircle,
    primary: true,
  },
  { href: "/packages", label: "Packages", hint: "Browse tiers", icon: PackageIcon, primary: false },
  { href: "/deposit", label: "Deposit", hint: "Add funds", icon: ArrowDownToLine, primary: false },
  { href: "/withdraw", label: "Withdraw", hint: "Cash out", icon: ArrowUpFromLine, primary: false },
] as const;

export default function DashboardPage() {
  const {
    state,
    totalBalance,
    activePackages,
    todayEarnings,
    quotaRemaining,
    dailyQuota,
  } = useStore();
  const [selected, setSelected] = React.useState<Package | null>(null);

  /* Three teasers from the bottom of the table — the entry tiers a new account
     would realistically start with. The full catalogue lives on /packages. */
  const teasers = PACKAGES.slice(0, 3);
  const ownedIds = activePackages.map((p) => p.packageId);

  return (
    <AppShell>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-extrabold tracking-tight text-white sm:text-2xl">
            Welcome back, {state.user.name.split(" ")[0]}
          </h1>
          <p className="mt-1 flex items-center gap-1.5 text-[13px] text-muted">
            <ShieldCheck className="h-3.5 w-3.5 text-cash" aria-hidden />
            Account {state.user.accountStatus}
          </p>
        </div>
        <Link href="/watch" className={buttonStyles({ variant: "flame", size: "md" })}>
          <PlayCircle className="h-4 w-4" aria-hidden />
          Start earning
        </Link>
      </div>

      <BalanceCard
        total={totalBalance}
        available={state.wallet.available}
        locked={state.wallet.locked}
      />

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Available"
          value={formatMoneyCompact(state.wallet.available)}
          tone="positive"
        />
        <StatCard
          label="Locked"
          value={formatMoneyCompact(state.wallet.locked)}
          tone="accent"
          hint="Pending withdrawals"
        />
        <StatCard label="Today's earnings" value={formatMoneyCompact(todayEarnings)} />
        <StatCard
          label="Active packages"
          value={String(activePackages.length)}
          hint={dailyQuota > 0 ? `${quotaRemaining} of ${dailyQuota} tasks left` : "None active"}
        />
      </div>

      <section aria-label="Quick actions" className="mt-4 grid grid-cols-2 gap-3">
        {ACTIONS.map((action) => {
          const Icon = action.icon;
          return (
            <Link
              key={action.href}
              href={action.href}
              className={
                action.primary
                  ? "group relative flex flex-col gap-2 rounded-card border border-flame/60 bg-gradient-to-b from-flame/[0.14] to-transparent p-3.5 transition hover:border-flame hover:from-flame/20"
                  : "group flex flex-col gap-2 rounded-card border border-hairline bg-card p-3.5 transition hover:border-brand/50"
              }
            >
              <span
                className={
                  action.primary
                    ? "grid h-9 w-9 place-items-center rounded-tile bg-gradient-to-b from-flame-400 to-flame text-white shadow-flame"
                    : "grid h-9 w-9 place-items-center rounded-tile border border-hairline bg-raised text-brand-400"
                }
              >
                <Icon className="h-[18px] w-[18px]" aria-hidden />
              </span>
              <span>
                <span className="block text-[13px] font-bold text-white">{action.label}</span>
                <span className="mt-0.5 block text-[11px] text-muted">{action.hint}</span>
              </span>
            </Link>
          );
        })}
      </section>

      <section className="mt-5" aria-labelledby="your-packages">
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <h2 id="your-packages" className="text-[15px] font-bold tracking-tight text-white">
            Your packages
          </h2>
          <Link
            href="/packages"
            className="inline-flex items-center gap-1 text-xs font-semibold text-brand-400 transition hover:text-brand"
          >
            View all
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>

        {activePackages.length === 0 ? (
          <div className="tc-card flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-tile border border-hairline bg-raised text-muted">
                <PackageIcon className="h-[18px] w-[18px]" aria-hidden />
              </span>
              <div>
                <p className="text-[13px] font-bold text-white">No active package</p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted">
                  Activate a tier to unlock daily watch tasks and start earning.
                </p>
              </div>
            </div>
            <Link href="/packages" className={buttonStyles({ variant: "flame", size: "sm" })}>
              Browse packages
            </Link>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {activePackages.map((owned) => {
              const tier = getPackage(owned.packageId);
              if (!tier) return null;
              return (
                <div key={owned.packageId} className="tc-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="tc-label truncate">{tier.name}</p>
                      <p className="tc-value mt-1 text-xl">
                        {formatMoneyCompact(tier.dailyEarnings)}
                        <span className="ml-1 text-xs font-semibold text-muted">/ day</span>
                      </p>
                    </div>
                    <StatusBadge tone="active" dot>
                      Active
                    </StatusBadge>
                  </div>

                  <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-muted">
                    <Timer className="h-3.5 w-3.5 text-cash" aria-hidden />
                    {/*
                      Each card counts down its own expiry. Using a single
                      soonest-expiry value here made every active tier display the
                      same remaining time, which was simply wrong for the rest.
                    */}
                    {formatCountdown(new Date(owned.expiresAt).getTime() - Date.now())}
                    <span className="mx-0.5 text-hairline">•</span>
                    {quotaRemaining} of {tier.tasksPerDay} tasks left today
                  </p>

                  <div className="mt-3 flex gap-2">
                    <Link
                      href="/watch"
                      className={buttonStyles({ variant: "brand", size: "sm", full: true })}
                    >
                      Watch
                    </Link>
                    <Link
                      href={`/packages/${tier.id}`}
                      className={buttonStyles({ variant: "outline", size: "sm", full: true })}
                    >
                      Details
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-5" aria-labelledby="available-packages">
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <h2
            id="available-packages"
            className="flex items-center gap-2 text-[15px] font-bold tracking-tight text-white"
          >
            <Sparkles className="h-4 w-4 text-flame-400" aria-hidden />
            Available packages
          </h2>
          <Link
            href="/packages"
            className="inline-flex items-center gap-1 text-xs font-semibold text-brand-400 transition hover:text-brand"
          >
            Full catalogue
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {teasers.map((pkg) => (
            <PackageCard
              key={pkg.id}
              pkg={pkg}
              owned={ownedIds.includes(pkg.id)}
              onBuy={setSelected}
            />
          ))}
        </div>
      </section>

      {/*
        Company paperwork sits below the content, as it does in production. It is
        a trust signal, not a dashboard metric, so it never competes with the
        balance for attention.
      */}
      <footer className="mt-5 flex flex-col items-start gap-3 border-t border-hairline pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[12px] font-semibold text-white">TASK CASH PRO LIMITED</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted">
            Registered company documents, as filed.
          </p>
        </div>
        <ComplianceDocuments />
      </footer>

      <PurchaseModal pkg={selected} onClose={() => setSelected(null)} />
    </AppShell>
  );
}
