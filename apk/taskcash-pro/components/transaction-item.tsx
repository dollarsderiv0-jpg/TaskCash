import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Gift,
  PlayCircle,
  Package,
  type LucideIcon,
} from "lucide-react";
import {
  cn,
  formatDateTime,
  formatMoney,
  formatSigned,
  isCredit,
  TRANSACTION_LABELS,
} from "@/lib/format";
import { feeForTransaction, netForTransaction } from "@/lib/fees";
import type { Transaction, TransactionKind } from "@/lib/types";
import { StatusBadge } from "./status-badge";

const ICONS: Record<TransactionKind, LucideIcon> = {
  task_reward: PlayCircle,
  package_activation: Package,
  deposit: ArrowDownToLine,
  withdrawal: ArrowUpFromLine,
  bonus: Gift,
};

/** Colour carries the direction: green in, orange out. */
const TONES: Record<TransactionKind, string> = {
  task_reward: "border-cash/35 bg-cash/10 text-cash",
  deposit: "border-cash/35 bg-cash/10 text-cash",
  bonus: "border-cash/35 bg-cash/10 text-cash",
  withdrawal: "border-flame/35 bg-flame/10 text-flame-400",
  package_activation: "border-flame/35 bg-flame/10 text-flame-400",
};

export function TransactionItem({
  transaction,
  className,
}: {
  transaction: Transaction;
  className?: string;
}) {
  const Icon = ICONS[transaction.kind];
  const credit = isCredit(transaction.kind);
  const failed = transaction.status === "failed";

  /*
   * The 10% fee is charged on every withdrawal, so `fees.ts` derives it from the
   * gross when a row does not carry its own figures. That keeps entries written
   * before the rule existed — or restored from an older localStorage payload —
   * from rendering as though they were fee-free.
   */
  const isWithdrawal = transaction.kind === "withdrawal";
  const fee = isWithdrawal
    ? feeForTransaction(transaction.amount, transaction.fee)
    : undefined;
  const net =
    fee === undefined
      ? undefined
      : netForTransaction(transaction.amount, fee, transaction.net);

  return (
    <li className={cn("flex items-center gap-3 px-3.5 py-3", className)}>
      <span
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-tile border",
          TONES[transaction.kind],
        )}
      >
        <Icon className="h-[17px] w-[17px]" aria-hidden />
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold text-white">{transaction.title}</p>
        <p className="truncate text-[11px] text-muted">
          {TRANSACTION_LABELS[transaction.kind]}
          <span className="mx-1 text-hairline">•</span>
          {formatDateTime(transaction.createdAt)}
          {transaction.reference ? (
            <>
              <span className="mx-1 text-hairline">•</span>
              {transaction.reference}
            </>
          ) : null}
        </p>
        {/*
          A withdrawn row shows the gross that left the balance and the net that
          will arrive. Showing only the gross would make a fee look like money
          that went missing.
        */}
        {fee !== undefined && net !== undefined ? (
          <p className="mt-0.5 truncate text-[11px] text-muted/90">
            Fee {formatMoney(fee)}
            <span className="mx-1 text-hairline">•</span>
            You receive <span className="tnum font-semibold text-cash">{formatMoney(net)}</span>
          </p>
        ) : null}
      </div>

      <div className="shrink-0 text-right">
        <p
          className={cn(
            "tnum text-[13px] font-bold",
            failed ? "text-muted line-through" : credit ? "text-cash" : "text-flame-400",
          )}
        >
          {formatSigned(transaction.amount, transaction.kind)}
        </p>
        <StatusBadge
          tone={failed ? "failed" : transaction.status === "pending" ? "pending" : "neutral"}
          className="mt-1 border-0 bg-transparent px-0 py-0 text-[10px] tracking-[0.08em]"
        >
          {transaction.status}
        </StatusBadge>
      </div>
    </li>
  );
}
