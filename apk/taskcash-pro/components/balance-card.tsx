import * as React from "react";
import { Wallet } from "lucide-react";
import { cn, formatMoney } from "@/lib/format";

export function BalanceCard({
  total,
  available,
  locked,
  className,
  action,
}: {
  total: number;
  available: number;
  locked: number;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-card border border-hairline bg-card p-4 shadow-card sm:p-5",
        className,
      )}
    >
      {/* Accent bloom, kept low-opacity so it never fights the figure. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-brand/20 blur-3xl"
      />

      <div className="relative flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="tc-label">Total wallet balance</p>
          <p className="tc-value mt-1 text-3xl leading-none sm:text-4xl">{formatMoney(total)}</p>
          <p className="mt-2 text-xs text-muted">
            Available <span className="tnum font-semibold text-cash">{formatMoney(available)}</span>
            <span className="mx-1.5 text-hairline">•</span>
            Locked <span className="tnum font-semibold text-flame-400">{formatMoney(locked)}</span>
          </p>
        </div>
        <div className="flex flex-col items-end gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-tile border border-hairline bg-raised text-brand-400">
            <Wallet className="h-[18px] w-[18px]" aria-hidden />
          </span>
          {action}
        </div>
      </div>
    </section>
  );
}
