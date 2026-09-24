"use client";

import * as React from "react";
import { ReceiptText } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { TransactionItem } from "@/components/transaction-item";
import { cn, formatMoneyCompact, isCredit } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { TransactionKind } from "@/lib/types";

type Filter = "all" | TransactionKind;

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "task_reward", label: "Rewards" },
  { key: "deposit", label: "Deposits" },
  { key: "withdrawal", label: "Withdrawals" },
  { key: "package_activation", label: "Packages" },
  { key: "bonus", label: "Bonus" },
];

export default function TransactionsPage() {
  const { state } = useStore();
  const [filter, setFilter] = React.useState<Filter>("all");

  const all = state.transactions;
  const rows = filter === "all" ? all : all.filter((t) => t.kind === filter);
  const inflow = all.filter((t) => isCredit(t.kind) && t.status === "completed").reduce((s, t) => s + t.amount, 0);
  const outflow = all.filter((t) => !isCredit(t.kind) && t.status !== "failed").reduce((s, t) => s + t.amount, 0);

  return (
    <AppShell>
      <PageHeader
        title="Transactions"
        subtitle="Every movement in the demo ledger, newest first."
      />

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Money in" value={formatMoneyCompact(inflow)} tone="positive" />
        <StatCard label="Money out" value={formatMoneyCompact(outflow)} tone="accent" />
        <StatCard label="Entries" value={String(all.length)} />
      </div>

      <div className="no-scrollbar mt-4 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Filter transactions">
        {FILTERS.map((option) => (
          <button
            key={option.key}
            type="button"
            role="tab"
            aria-selected={filter === option.key}
            onClick={() => setFilter(option.key)}
            className={cn(
              "shrink-0 rounded-full border px-3.5 py-1.5 text-[12px] font-semibold transition",
              filter === option.key
                ? "border-brand bg-brand/20 text-white"
                : "border-hairline bg-card text-muted hover:text-white",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="tc-card mt-3 overflow-hidden p-0">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2.5 px-5 py-12 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-full border border-hairline bg-raised text-muted">
              <ReceiptText className="h-5 w-5" aria-hidden />
            </span>
            <p className="text-[13px] font-bold text-white">No entries in this view</p>
            <p className="max-w-xs text-[11px] leading-snug text-muted">
              Nothing matches this filter yet. Try “All”, or claim a task reward to create an entry.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-hairline/70">
            {rows.map((transaction) => (
              <TransactionItem key={transaction.id} transaction={transaction} />
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
