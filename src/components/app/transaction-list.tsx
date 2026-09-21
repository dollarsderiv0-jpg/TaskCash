import { ArrowDownLeft, ArrowUpRight, Receipt } from "lucide-react";
import { Badge, EmptyState, statusBadgeVariant } from "@/components/ui/misc";
import { formatDateTime, formatMoney } from "@/lib/money/format";
import { TRANSACTION_TYPE_LABELS, statusLabel, type WalletTransaction } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Renders ledger entries exactly as recorded. The sign shown is derived from
 * the stored balance effect, not from a client-side guess.
 */
export function TransactionList({
  transactions,
  emptyTitle = "No transactions yet",
  emptyDescription = "Your ledger entries will appear here as soon as money moves.",
}: {
  transactions: WalletTransaction[];
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  if (transactions.length === 0) {
    return (
      <EmptyState icon={Receipt} title={emptyTitle} description={emptyDescription} />
    );
  }

  return (
    <ul className="divide-y divide-border">
      {transactions.map((tx) => {
        const isCredit = Number(tx.available_delta) > 0;
        const isNeutral = Number(tx.available_delta) === 0 && Number(tx.locked_delta) !== 0;
        const Icon = isNeutral ? Receipt : isCredit ? ArrowDownLeft : ArrowUpRight;

        return (
          <li key={tx.id} className="flex items-start gap-3 py-3.5">
            <div
              className={cn(
                "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                isNeutral
                  ? "bg-secondary"
                  : isCredit
                    ? "bg-emeraldBrand-500/12"
                    : "bg-rose-500/12",
              )}
            >
              <Icon
                className={cn(
                  "h-4 w-4",
                  isNeutral
                    ? "text-muted-foreground"
                    : isCredit
                      ? "text-emeraldBrand-600 dark:text-emeraldBrand-400"
                      : "text-rose-600 dark:text-rose-400",
                )}
                aria-hidden
              />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {TRANSACTION_TYPE_LABELS[tx.type] ?? tx.type}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{formatDateTime(tx.created_at)}</p>
                </div>
                <div className="text-right">
                  <p
                    className={cn(
                      "text-sm font-semibold tabular-nums",
                      isNeutral ? "text-muted-foreground" : isCredit ? "tc-amount-in" : "tc-amount-out",
                    )}
                  >
                    {isNeutral ? "" : isCredit ? "+" : "−"}
                    {formatMoney(tx.amount, tx.currency, { withSymbol: false })}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{tx.currency}</p>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge variant={statusBadgeVariant(tx.status)}>{statusLabel(tx.status)}</Badge>
                <span className="font-mono text-[11px] text-muted-foreground">{tx.reference}</span>
              </div>

              {isNeutral ? (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Held in your locked balance — no change to your total balance.
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
