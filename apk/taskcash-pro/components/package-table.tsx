"use client";

import Link from "next/link";
import { formatMoneyCompact } from "@/lib/format";
import type { ID, Package } from "@/lib/types";
import { PackageCard } from "./package-card";
import { buttonStyles } from "./primary-button";
import { StatusBadge } from "./status-badge";

const COLUMNS = [
  "Package Price",
  "Days",
  "Daily Pay",
  "Task Cost",
  "Tasks / Day",
  "Total Return",
  "Net Profit",
  "",
] as const;

/**
 * The published tier table. A real `<table>` above `md` because the columns are
 * genuinely tabular and should be scannable; below `md` the same rows are
 * rendered as cards, which is the only layout that survives a phone width.
 */
export function PackageTable({
  packages,
  ownedIds,
  onBuy,
}: {
  packages: Package[];
  ownedIds: ID[];
  onBuy?: (pkg: Package) => void;
}) {
  const owned = (id: ID) => ownedIds.includes(id);

  return (
    <>
      <div className="tc-card hidden overflow-hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[840px] border-collapse text-left">
            <caption className="sr-only">
              TaskCash Pro package tiers with prices, daily pay and projected returns
            </caption>
            <thead>
              <tr className="border-b border-hairline bg-raised/70">
                {COLUMNS.map((column, index) => (
                  <th
                    key={`${column}-${index}`}
                    scope="col"
                    className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {packages.map((pkg, index) => {
                const isOwned = owned(pkg.id);
                return (
                  <tr
                    key={pkg.id}
                    className={
                      /* Zebra striping only — a hover wash on every row of a
                         dense table reads as noise. */
                      index % 2 === 1 ? "bg-white/[0.015]" : undefined
                    }
                  >
                    <th scope="row" className="px-3 py-2.5 text-[13px] font-bold text-white">
                      {formatMoneyCompact(pkg.price)}
                      {isOwned ? (
                        <StatusBadge tone="active" className="ml-2 align-middle">
                          Active
                        </StatusBadge>
                      ) : null}
                    </th>
                    <td className="tnum px-3 py-2.5 text-[13px] text-white/85">{pkg.days}</td>
                    <td className="tnum px-3 py-2.5 text-[13px] text-white/85">
                      {formatMoneyCompact(pkg.dailyEarnings)}
                    </td>
                    <td className="tnum px-3 py-2.5 text-[13px] text-white/85">
                      {formatMoneyCompact(pkg.taskCost)}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="tnum inline-flex rounded-md border border-brand/40 bg-brand/20 px-2 py-0.5 text-[12px] font-semibold text-white">
                        {pkg.tasksPerDay} tasks
                      </span>
                    </td>
                    <td className="tnum px-3 py-2.5 text-[13px] text-white/85">
                      {formatMoneyCompact(pkg.totalReturn)}
                    </td>
                    <td className="tnum px-3 py-2.5 text-[13px] font-semibold text-cash">
                      +{formatMoneyCompact(pkg.netProfit)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {isOwned ? (
                        <Link
                          href={`/packages/${pkg.id}`}
                          className={buttonStyles({ variant: "outline", size: "sm" })}
                        >
                          Watch
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onBuy?.(pkg)}
                          className={buttonStyles({ variant: "flame", size: "sm" })}
                        >
                          Buy
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-3 md:hidden">
        {packages.map((pkg) => (
          <PackageCard key={pkg.id} pkg={pkg} owned={owned(pkg.id)} onBuy={onBuy} />
        ))}
      </div>
    </>
  );
}
