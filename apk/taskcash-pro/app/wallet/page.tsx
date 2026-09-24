"use client";

import Link from "next/link";
import { ArrowUpFromLine, ChevronRight } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { BalanceCard } from "@/components/balance-card";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { TransactionItem } from "@/components/transaction-item";
import { buttonStyles } from "@/components/primary-button";
import { feeForTransaction } from "@/lib/fees";
import { formatMoneyCompact } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function WalletPage() {
  const { state, totalBalance, packageEarnings } = useStore();

  const sumOf = (kind: "deposit" | "withdrawal") =>
    state.transactions
      .filter((t) => t.kind === kind && t.status !== "failed")
      .reduce((sum, t) => sum + t.amount, 0);

  const recent = state.transactions.slice(0, 5);

  return (
    <AppShell>
      <PageHeader
        title="Wallet"
        subtitle="Mock balance, cash-flow totals and your most recent movements."
        actions={
          <Link href="/withdraw" className={buttonStyles({ variant: "flame", size: "sm" })}>
            <ArrowUpFromLine className="h-3.5 w-3.5" aria-hidden />
            Cash out
          </Link>
        }
      />

      <BalanceCard
        total={totalBalance}
        available={state.wallet.available}
        locked={state.wallet.locked}
      />

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Deposits" value={formatMoneyCompact(sumOf("deposit"))} tone="positive" />
        <StatCard
          label="Withdrawals"
          value={formatMoneyCompact(sumOf("withdrawal"))}
          tone="accent"
        />
        {/* Shown separately from the withdrawal total: the fee is money the user
            spent, not money they received. */}
        <StatCard
          label="Fees paid"
          value={formatMoneyCompact(
            state.transactions
              .filter((t) => t.kind === "withdrawal" && t.status !== "failed")
              .reduce((sum, t) => sum + feeForTransaction(t.amount, t.fee), 0),
          )}
          tone="accent"
        />
        <StatCard label="Reward earnings" value={formatMoneyCompact(packageEarnings)} />
      </div>

      <section className="mt-4" aria-labelledby="recent-activity">
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <h2 id="recent-activity" className="text-[15px] font-bold tracking-tight text-white">
            Recent activity
          </h2>
          <Link
            href="/transactions"
            className="inline-flex items-center gap-1 text-xs font-semibold text-brand-400 transition hover:text-brand"
          >
            View all
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>

        <div className="tc-card divide-y divide-hairline/70 overflow-hidden p-0">
          {recent.length === 0 ? (
            <p className="px-4 py-8 text-center text-[12px] text-muted">
              No movements yet. Deposit or claim a task reward to get started.
            </p>
          ) : (
            <ul className="divide-y divide-hairline/70">
              {recent.map((transaction) => (
                <TransactionItem key={transaction.id} transaction={transaction} />
              ))}
            </ul>
          )}
        </div>
      </section>

      <p className="mt-4 text-center text-[10px] leading-snug text-muted/80">
        Demo wallet. Balances are stored in your browser and no funds are real or transferable.
      </p>
    </AppShell>
  );
}
