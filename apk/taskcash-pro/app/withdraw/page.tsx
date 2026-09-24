"use client";

import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { TransactionItem } from "@/components/transaction-item";
import { WalletCard } from "@/components/wallet-card";
import { useToast } from "@/components/toast";
import { formatMoneyCompact } from "@/lib/format";
import { WITHDRAWAL_FEE_PCT, feeForTransaction, netForTransaction } from "@/lib/fees";
import { useStore } from "@/lib/store";

export default function WithdrawPage() {
  const { state, requestWithdrawal } = useStore();
  const toast = useToast();

  const withdrawals = state.transactions.filter((t) => t.kind === "withdrawal");
  const pending = withdrawals.filter((t) => t.status === "pending");

  return (
    <AppShell>
      <PageHeader
        title="Withdraw"
        subtitle={`Request a payout to M-PESA. A ${WITHDRAWAL_FEE_PCT}% fee applies to every withdrawal, and requests are held as pending until approved.`}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Available"
          value={formatMoneyCompact(state.wallet.available)}
          tone="positive"
        />
        <StatCard
          label="In escrow"
          value={formatMoneyCompact(state.wallet.locked)}
          tone="accent"
          hint={`${pending.length} pending request${pending.length === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Net received"
          value={formatMoneyCompact(
            withdrawals
              .filter((t) => t.status === "completed")
              .reduce((sum, t) => {
                const fee = feeForTransaction(t.amount, t.fee);
                return sum + netForTransaction(t.amount, fee, t.net);
              }, 0),
          )}
        />
        {/*
          The fee is a real cost, so it gets its own figure rather than being
          folded into the withdrawal total. `feeOn` backs the total up for rows
          written before the fee existed — otherwise a row would show a fee while
          the total read zero.
        */}
        <StatCard
          label="Fees paid"
          value={formatMoneyCompact(
            withdrawals
              .filter((t) => t.status !== "failed")
              .reduce((sum, t) => sum + feeForTransaction(t.amount, t.fee), 0),
          )}
          tone="accent"
          hint={`${WITHDRAWAL_FEE_PCT}% of every cashout`}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <WalletCard
          available={state.wallet.available}
          defaultPhone={state.user.phone}
          onSubmit={(amount, phone) => {
            const result = requestWithdrawal(amount, phone);
            if (result.ok) {
              const { gross, fee, net } = result.quote ?? { gross: amount, fee: 0, net: amount };
              toast.success(
                "Withdrawal requested",
                `${formatMoneyCompact(net)} on its way — ${formatMoneyCompact(fee)} fee on ${formatMoneyCompact(gross)}.`,
              );
            }
            return result;
          }}
        />

        <section className="tc-card overflow-hidden p-0" aria-labelledby="withdrawal-history">
          <h2
            id="withdrawal-history"
            className="border-b border-hairline px-4 py-3 text-[15px] font-bold tracking-tight text-white"
          >
            Withdrawal history
          </h2>
          {withdrawals.length === 0 ? (
            <p className="px-4 py-10 text-center text-[12px] text-muted">
              No withdrawals yet. Your first request will appear here with its reference number.
            </p>
          ) : (
            <ul className="divide-y divide-hairline/70">
              {withdrawals.map((transaction) => (
                <TransactionItem key={transaction.id} transaction={transaction} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  );
}
