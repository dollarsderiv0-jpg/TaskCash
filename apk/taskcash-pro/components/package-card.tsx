"use client";

import Link from "next/link";
import { Clock3, Coins, Film, TrendingUp } from "lucide-react";
import { cn, formatMoneyCompact } from "@/lib/format";
import type { Package } from "@/lib/types";
import { buttonStyles } from "./primary-button";
import { StatusBadge } from "./status-badge";

/**
 * One tier. Everything shown is derived from the single published row, so the
 * price, the per-task rate and the totals can never disagree with the table.
 */
export function PackageCard({
  pkg,
  owned = false,
  onBuy,
  className,
}: {
  pkg: Package;
  owned?: boolean;
  onBuy?: (pkg: Package) => void;
  className?: string;
}) {
  const facts = [
    { icon: Coins, label: "Daily", value: formatMoneyCompact(pkg.dailyEarnings) },
    { icon: Film, label: "Tasks/day", value: String(pkg.tasksPerDay) },
    { icon: TrendingUp, label: "Per task", value: formatMoneyCompact(pkg.taskCost) },
    { icon: Clock3, label: "Duration", value: `${pkg.days} days` },
  ];

  return (
    <article
      className={cn(
        "tc-card flex flex-col p-4 transition hover:border-brand/40",
        owned && "border-cash/40",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="tc-label truncate">{pkg.name}</p>
          <p className="tc-value mt-1 text-2xl">{formatMoneyCompact(pkg.price)}</p>
        </div>
        <StatusBadge tone={owned ? "active" : "inactive"} dot={owned}>
          {owned ? "Active" : "Not active"}
        </StatusBadge>
      </div>

      <dl className="mt-3.5 grid grid-cols-2 gap-2">
        {facts.map((fact) => {
          const Icon = fact.icon;
          return (
            <div
              key={fact.label}
              className="rounded-tile border border-hairline bg-base/40 px-2.5 py-2"
            >
              <dt className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                <Icon className="h-3 w-3" aria-hidden />
                {fact.label}
              </dt>
              <dd className="tnum mt-0.5 text-[13px] font-bold text-white">{fact.value}</dd>
            </div>
          );
        })}
      </dl>

      <div className="mt-3 border-t border-hairline pt-2">
        <div className="tc-row">
          <span className="tc-row-label">Maximum total</span>
          <span className="tc-row-value">{formatMoneyCompact(pkg.totalReturn)}</span>
        </div>
        <div className="tc-row">
          <span className="tc-row-label">Net profit</span>
          <span className="tc-row-value text-cash">
            +{formatMoneyCompact(pkg.netProfit)}
            <span className="ml-1.5 text-[11px] font-semibold text-muted">
              ({pkg.netReturnPct}%)
            </span>
          </span>
        </div>
      </div>

      <div className="mt-3.5">
        {owned ? (
          <Link href={`/packages/${pkg.id}`} className={buttonStyles({ variant: "brand", full: true })}>
            Watch
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => onBuy?.(pkg)}
            className={buttonStyles({ variant: "flame", full: true })}
          >
            Buy
          </button>
        )}
      </div>

      <p className="mt-2 text-[10px] leading-snug text-muted/80">
        Earnings depend on eligible campaigns and available campaign budgets. No guaranteed returns.
      </p>
    </article>
  );
}
