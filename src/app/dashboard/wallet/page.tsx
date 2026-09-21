import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Banknote,
  Coins,
  Lock,
  Receipt,
  Smartphone,
} from "lucide-react";
import { guardPage } from "@/lib/auth/guards";
import { getEarningsSummary, getWalletOverview, listWalletTransactions } from "@/server/services/wallet";
import { getWithdrawalPreview, listUserWithdrawals } from "@/server/services/withdrawals";
import { StatCard } from "@/components/app/stat-card";
import { EarningsChart } from "@/components/app/earnings-chart";
import { TransactionList } from "@/components/app/transaction-list";
import { RecoveryButton } from "@/components/app/recovery-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, EmptyState, Separator, statusBadgeVariant } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatMoney } from "@/lib/money/format";
import { statusLabel } from "@/lib/types";

export const metadata: Metadata = { title: "Wallet" };

export const dynamic = "force-dynamic";

/**
 * History filters.
 *
 * The groups match how a user thinks about their money rather than how the
 * ledger names it: "Earned" gathers the three reward kinds, and "Withdrawals"
 * gathers the hold, the payout and its release, because a user asking "where
 * did my withdrawal go?" needs all of them in one list.
 */
const HISTORY_FILTERS: {
  key: string;
  label: string;
  types: string[] | null;
  emptyTitle: string;
  emptyDescription: string;
}[] = [
  {
    key: "all",
    label: "All",
    types: null,
    emptyTitle: "No transactions yet",
    emptyDescription: "Your ledger entries will appear here as soon as money moves.",
  },
  {
    key: "earned",
    label: "Earned",
    types: ["VIDEO_REWARD", "TASK_REWARD", "REFERRAL_REWARD"],
    emptyTitle: "No rewards yet",
    emptyDescription:
      "Rewards you earn from campaigns and referrals will appear here. Nothing in this category so far — try All to see every entry.",
  },
  {
    key: "deposits",
    label: "Deposits",
    types: ["DEPOSIT"],
    emptyTitle: "No deposits yet",
    emptyDescription:
      "Money you add to your wallet will appear here once the payment provider confirms it.",
  },
  {
    key: "withdrawals",
    label: "Withdrawals",
    types: ["WITHDRAWAL", "WITHDRAWAL_HOLD", "WITHDRAWAL_RELEASE", "WITHDRAWAL_FEE"],
    emptyTitle: "No withdrawals yet",
    emptyDescription:
      "Requests you make, and any amount held or released while they are reviewed, will appear here.",
  },
];

export default async function WalletPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const params = await searchParams;
  const activeFilter =
    HISTORY_FILTERS.find((filter) => filter.key === params.filter) ?? HISTORY_FILTERS[0];

  const session = await guardPage();
  const userId = session.profile.id;
  const currency = session.wallet.currency;

  const [overview, earnings, transactions, withdrawals, preview] = await Promise.all([
    getWalletOverview(userId),
    getEarningsSummary(userId),
    listWalletTransactions(userId, { pageSize: 25, types: activeFilter.types }),
    listUserWithdrawals(userId, 10),
    getWithdrawalPreview({ profile: session.profile, wallet: session.wallet }),
  ]);

  const available = Number(session.wallet.available_balance);
  const locked = Number(session.wallet.locked_balance);

  /*
    Whether this account has the app on a device (migration 0018).

    It decides one thing: whether the withdrawal limits are shown below. They are
    deliberately absent from the website — the app is where a user sees the floor,
    the fee and the rolling limit — so an account with no recorded install gets the
    pointer to the app instead of the figures. Absent column (pre-0018 database) or
    absent value both read as "no app", which is the safe direction.
  */
  const hasApp = Boolean(session.profile.app_downloaded_at);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Wallet</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every movement is recorded permanently, so your history always matches your balance.
          </p>
        </div>
        <RecoveryButton />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Available balance"
          value={formatMoney(available, currency)}
          hint="Ready to use or withdraw"
          icon={Coins}
          tone="success"
        />
        <StatCard
          label="Locked balance"
          value={formatMoney(locked, currency)}
          hint="Reserved by a withdrawal in review"
          icon={Lock}
          tone="warning"
        />
        <StatCard
          label="Total earned"
          value={formatMoney(overview?.totalEarned ?? 0, currency)}
          hint="Rewards credited to date"
          icon={Receipt}
        />
        <StatCard
          label="Total withdrawn"
          value={formatMoney(overview?.totalWithdrawn ?? 0, currency)}
          hint={`Deposited ${formatMoney(overview?.totalDeposited ?? 0, currency)}`}
          icon={Banknote}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Button asChild>
          <Link href="/dashboard/deposit">
            <ArrowDownToLine className="h-4 w-4" aria-hidden />
            Deposit
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/dashboard/withdraw">
            <ArrowUpFromLine className="h-4 w-4" aria-hidden />
            Withdraw
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/dashboard/watch">Watch &amp; Earn</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/dashboard/referrals">Referrals</Link>
        </Button>
      </div>

      {/*
        Where the balance stands: the 30-day earning history and the terms a
        withdrawal will actually meet, side by side, in the order a user asks the
        questions — "what have I earned?" then "what happens when I take it out?".
      */}
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Earnings · last 30 days</CardTitle>
            <CardDescription>Recorded reward credits from your wallet ledger.</CardDescription>
          </CardHeader>
          <CardContent>
            <EarningsChart data={earnings.earningsSeries} currency={currency} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Withdrawal readiness</CardTitle>
            <CardDescription>
              {hasApp
                ? "The terms your next request will be measured against."
                : "Reviewed by our administration team before any payment is sent."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <Row label="Available" value={formatMoney(available, currency)} />
            {hasApp ? (
              <>
                <Row label="Minimum" value={formatMoney(preview.minimum, currency)} />
                <Row label="Fee" value={formatMoney(preview.fee, currency)} />
                <Row
                  label="Daily remaining"
                  value={formatMoney(preview.dailyRemaining, currency)}
                />
              </>
            ) : (
              <div className="rounded-lg border border-dashed border-border p-3">
                <p className="flex items-center gap-1.5 text-sm font-semibold">
                  <Smartphone className="h-4 w-4 text-muted-foreground" aria-hidden />
                  Limits are shown in the app
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  The minimum, the fee and your 24-hour ceiling appear on this screen once
                  TaskCash Pro is on your device.
                </p>
                <Link
                  href="/dashboard/install"
                  className="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground"
                >
                  GET THE APP
                </Link>
              </div>
            )}
            <Separator />
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Account status</span>
                <Badge variant={session.profile.status === "ACTIVE" ? "success" : "warning"}>
                  {statusLabel(session.profile.status)}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Verification</span>
                <Badge variant={session.profile.kyc_status === "VERIFIED" ? "success" : "default"}>
                  {statusLabel(session.profile.kyc_status)}
                </Badge>
              </div>
            </div>
            <Button asChild className="w-full">
              <Link href="/dashboard/withdraw">
                {available >= preview.minimum ? "Request withdrawal" : "View withdrawal details"}
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Withdrawal requests</CardTitle>
          <CardDescription>
            Reviewed by our administration team before any payment is sent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {withdrawals.length === 0 ? (
            <EmptyState
              icon={Banknote}
              title="No withdrawal requests yet"
              description="Once you request a payout it will appear here with its review status."
              className="py-8"
            />
          ) : (
            <ul className="divide-y divide-border">
              {withdrawals.map((withdrawal) => (
                <li key={withdrawal.id} className="flex items-center justify-between gap-4 py-3.5">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold tabular-nums">
                      {formatMoney(Number(withdrawal.amount), withdrawal.currency)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {withdrawal.phone} · {formatDateTime(withdrawal.requested_at)}
                    </p>
                    {withdrawal.rejection_reason ? (
                      <p className="mt-1 text-xs text-destructive">{withdrawal.rejection_reason}</p>
                    ) : null}
                  </div>
                  <Badge variant={statusBadgeVariant(withdrawal.status)}>
                    {statusLabel(withdrawal.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transaction history</CardTitle>
          <CardDescription>
            {activeFilter.key === "all"
              ? `${transactions.total} entr${transactions.total === 1 ? "y" : "ies"} recorded`
              : `${transactions.total} ${activeFilter.label.toLowerCase()} entr${
                  transactions.total === 1 ? "y" : "ies"
                } recorded`}
            {earnings.referralEarnings > 0
              ? ` · referral earnings ${formatMoney(earnings.referralEarnings, currency)}`
              : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <nav aria-label="Filter transaction history" className="mb-4">
            <ul className="flex flex-wrap gap-2">
              {HISTORY_FILTERS.map((filter) => {
                const active = filter.key === activeFilter.key;
                return (
                  <li key={filter.key}>
                    <Link
                      href={
                        filter.key === "all"
                          ? "/dashboard/wallet"
                          : `/dashboard/wallet?filter=${filter.key}`
                      }
                      aria-current={active ? "page" : undefined}
                      className={
                        active
                          ? "inline-flex min-h-9 items-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground"
                          : "inline-flex min-h-9 items-center rounded-full border border-border px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
                      }
                    >
                      {filter.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <TransactionList
            transactions={transactions.items}
            emptyTitle={activeFilter.emptyTitle}
            emptyDescription={activeFilter.emptyDescription}
          />
          {transactions.totalPages > 1 ? (
            <p className="mt-4 text-center text-xs text-muted-foreground">
              Showing the {transactions.items.length} most recent entries of {transactions.total}.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Separator />

      {/*
        Three terms appear on this screen and nowhere else in the user's life:
        available, locked, total. The old copy bundled them into a sentence
        about database reads, which answers a question nobody asked and skips the
        one they have. A plain disclosure costs no JavaScript, works with a
        keyboard, and is readable on a phone.
      */}
      <details className="rounded-xl border border-border bg-muted/20 p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          What do available, locked and total mean?
        </summary>
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="font-medium">Available balance</dt>
            <dd className="text-muted-foreground">
              Money you can use or request for withdrawal right now.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Locked balance</dt>
            <dd className="text-muted-foreground">
              Money set aside for a request that is still being reviewed. It is still yours — if a
              request is declined, the amount returns to your available balance automatically.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Total balance</dt>
            <dd className="text-muted-foreground">
              Your available and locked money added together.
            </dd>
          </div>
        </dl>
      </details>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Your balance is always read fresh from TaskCash&rsquo;s records when this page opens. If a
        figure ever looks wrong, reload the page and it will be read again.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}
