import {
  AlertTriangle,
  ArrowLeftRight,
  Banknote,
  Coins,
  Gift,
  Megaphone,
  Users,
  Wallet,
} from "lucide-react";
import { requireAdmin } from "@/lib/auth/guards";
import { getAdminDashboardStats, getPendingLiabilities } from "@/server/services/wallet";
import { getReportSeries, getReportTotals } from "@/server/services/admin";
import { StatCard } from "@/components/app/stat-card";
import { ReportCharts } from "@/components/admin/report-charts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge, Separator } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { formatMoney } from "@/lib/money/format";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  await requireAdmin();

  const [stats, totals, series, liabilities] = await Promise.all([
    getAdminDashboardStats(),
    getReportTotals(30),
    getReportSeries(30),
    getPendingLiabilities(),
  ]);

  const currency = liabilities.byCurrency[0]?.currency ?? "KES";
  const totalAvailable = liabilities.byCurrency.reduce((acc, item) => acc + item.available, 0);
  const totalLocked = liabilities.byCurrency.reduce((acc, item) => acc + item.locked, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Operations overview</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live figures aggregated from deposits, withdrawals, the ledger and referral commissions.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/withdrawals">Withdrawal queue</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/fraud">Fraud &amp; risk</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/admin/reconciliation">Reconciliation</Link>
          </Button>
        </div>
      </div>

      {stats.pendingWithdrawals > 0 ? (
        <Alert variant="warning" title={`${stats.pendingWithdrawals} withdrawal(s) awaiting review`}>
          <p>
            No payout is sent automatically. Each request needs an explicit administrator decision.
          </p>
        </Alert>
      ) : null}

      {stats.fraudAlerts > 0 ? (
        <Alert variant="warning" title={`${stats.fraudAlerts} item(s) need a decision in the risk queue`}>
          <p>
            These are flagged accounts and events, not confirmed fraud. Nothing is suspended
            automatically — open the queue and decide.{" "}
            <Link className="underline underline-offset-2" href="/admin/fraud">
              Review now
            </Link>
          </p>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total users" value={String(stats.totalUsers)} icon={Users} />
        <StatCard
          label="Active (7 days)"
          value={String(stats.activeUsers)}
          hint={`${stats.newUsersToday} new today`}
          icon={Users}
          tone="success"
        />
        <StatCard
          label="Deposits today"
          value={formatMoney(stats.depositsToday, currency)}
          hint={`${stats.pendingDeposits} pending`}
          icon={ArrowLeftRight}
          tone="success"
        />
        <StatCard
          label="Pending withdrawals"
          value={String(stats.pendingWithdrawals)}
          hint={`Paid today ${formatMoney(stats.completedWithdrawalsToday, currency)}`}
          icon={Wallet}
          tone="warning"
        />
        <StatCard
          label="Users needing review"
          value={String(stats.usersNeedingReview)}
          hint="Flagged by watch or payout patterns"
          icon={AlertTriangle}
          tone={stats.usersNeedingReview > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Fraud alerts"
          value={String(stats.fraudAlerts)}
          hint="Open items in the risk queue"
          icon={AlertTriangle}
          tone={stats.fraudAlerts > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Rewards today"
          value={formatMoney(stats.rewardsToday, currency)}
          icon={Coins}
        />
        <StatCard
          label="Referral commissions today"
          value={formatMoney(stats.referralCommissionsToday, currency)}
          icon={Gift}
        />
        <StatCard
          label="Campaign spend"
          value={formatMoney(stats.campaignSpend, currency)}
          hint={`of ${formatMoney(stats.campaignBudget, currency)} budget`}
          icon={Megaphone}
        />
        <StatCard
          label="Platform revenue (30d)"
          value={formatMoney(totals.netActivity, currency)}
          hint="Deposits minus completed payouts"
          icon={Banknote}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pending liabilities</CardTitle>
          <CardDescription>
            What the platform currently owes users. Locked funds are reserved by withdrawals in
            review; they are not yet paid out.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Available balances
              </p>
              <p className="mt-1 text-lg font-bold tabular-nums">
                {formatMoney(totalAvailable, currency)}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Locked balances</p>
              <p className="mt-1 text-lg font-bold tabular-nums">
                {formatMoney(totalLocked, currency)}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Withdrawals in flight
              </p>
              <p className="mt-1 text-lg font-bold tabular-nums">{liabilities.pendingWithdrawalCount}</p>
            </div>
          </div>

          <Separator />

          <div className="flex flex-wrap gap-2">
            {liabilities.byCurrency.map((item) => (
              <Badge key={item.currency} variant="outline">
                {item.currency}: available {formatMoney(item.available, item.currency)} · locked{" "}
                {formatMoney(item.locked, item.currency)}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <ReportCharts initial={series} initialDays={30} />

      <Card>
        <CardHeader>
          <CardTitle>30-day totals</CardTitle>
          <CardDescription>Every figure below is an aggregate of real records.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <Row label="Deposits" value={formatMoney(totals.deposits, currency)} />
            <Row label="Withdrawals paid" value={formatMoney(totals.withdrawals, currency)} />
            <Row label="Rewards issued" value={formatMoney(totals.rewards, currency)} />
            <Row
              label="Referral commissions"
              value={formatMoney(totals.referralCommissions, currency)}
            />
            <Row label="New users" value={String(totals.newUsers)} />
            <Row label="Failed payments" value={String(totals.failedPayments)} />
          </dl>

          {totals.failedPayments > 0 ? (
            <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-hidden />
              Failed payments are checked automatically and surfaced in reconciliation.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border pb-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
