import { requireAdmin } from "@/lib/auth/guards";
import { getReportSeries, getReportTotals } from "@/server/services/admin";
import { getPendingLiabilities } from "@/server/services/wallet";
import { ReportCharts } from "@/components/admin/report-charts";
import { ReportExportPanel } from "@/components/admin/report-export-panel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/money/format";

export const dynamic = "force-dynamic";

export default async function AdminReportsPage() {
  await requireAdmin();

  const [series, totals, liabilities] = await Promise.all([
    getReportSeries(30),
    getReportTotals(30),
    getPendingLiabilities(),
  ]);

  const currency = liabilities.byCurrency[0]?.currency ?? "KES";

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Daily revenue activity, campaign expenditure and pending liabilities, with date filtering.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Net platform activity (30 days)</CardTitle>
          <CardDescription>
            Deposits collected minus completed payouts. This is gross platform activity, not profit:
            campaign expenditure and operating costs are not deducted here.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Deposits" value={formatMoney(totals.deposits, currency)} />
          <Metric label="Withdrawals paid" value={formatMoney(totals.withdrawals, currency)} />
          <Metric label="Rewards issued" value={formatMoney(totals.rewards, currency)} />
          <Metric label="Referral commissions" value={formatMoney(totals.referralCommissions, currency)} />
          <Metric label="Campaign spend" value={formatMoney(totals.campaignSpend, currency)} />
          <Metric label="New users" value={String(totals.newUsers)} />
          <Metric label="Failed payments" value={String(totals.failedPayments)} />
          <Metric label="Withdrawals in review" value={String(liabilities.pendingWithdrawalCount)} />
        </CardContent>
      </Card>

      <ReportCharts initial={series} initialDays={30} />

      <ReportExportPanel />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-background p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-bold tabular-nums">{value}</p>
    </div>
  );
}
