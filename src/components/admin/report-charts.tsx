"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { apiRequest } from "@/lib/client/api";
import { formatMoneyShort } from "@/lib/money/format";

export type ReportPoint = {
  date: string;
  deposits: number;
  withdrawals: number;
  rewards: number;
  referralCommissions: number;
  failedPayments: number;
  newUsers: number;
};

const RANGES = [7, 30, 90] as const;

/**
 * Reporting charts. Every series is aggregated server-side directly from
 * deposits, withdrawals, ledger entries and referral commissions — there are
 * no synthetic or estimated points.
 */
export function ReportCharts({ initial, initialDays = 30 }: { initial: ReportPoint[]; initialDays?: number }) {
  const [days, setDays] = React.useState<number>(initialDays);
  const [series, setSeries] = React.useState<ReportPoint[]>(initial);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function changeRange(next: number) {
    setDays(next);
    setLoading(true);
    setError(null);

    const response = await apiRequest<{ series: ReportPoint[] }>(`/api/admin/reports?days=${next}`);
    if (response.ok) setSeries(response.data.series);
    else setError(response.message);

    setLoading(false);
  }

  const hasData = series.some(
    (point) => point.deposits > 0 || point.withdrawals > 0 || point.rewards > 0,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((range) => (
          <button
            key={range}
            type="button"
            onClick={() => void changeRange(range)}
            aria-pressed={days === range}
            className={
              days === range
                ? "rounded-full bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground"
                : "rounded-full border border-border px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary"
            }
          >
            Last {range} days
          </button>
        ))}
        {loading ? <span className="text-xs text-muted-foreground">Updating…</span> : null}
      </div>

      {error ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/8 p-3 text-sm">{error}</p>
      ) : null}

      {!hasData ? (
        <EmptyState
          title="No activity in this period"
          description="Once deposits, payouts and rewards are recorded, they will be charted here."
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Deposits vs withdrawals</CardTitle>
              <CardDescription>Completed amounts per day.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(value: string) => value.slice(5)}
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      axisLine={false}
                      tickLine={false}
                      minTickGap={20}
                    />
                    <YAxis
                      tickFormatter={(value: number) => formatMoneyShort(value, "KES").replace("KES ", "")}
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      axisLine={false}
                      tickLine={false}
                      width={48}
                    />
                    <Tooltip
                      formatter={(value: number) => formatMoneyShort(value, "KES")}
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "0.75rem",
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="deposits" name="Deposits" fill="hsl(158 68% 42%)" radius={[4, 4, 0, 0]} />
                    <Bar
                      dataKey="withdrawals"
                      name="Withdrawals"
                      fill="hsl(222 60% 55%)"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Rewards and referral commissions</CardTitle>
              <CardDescription>Credited reward value, including referral payouts.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(value: string) => value.slice(5)}
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      axisLine={false}
                      tickLine={false}
                      minTickGap={20}
                    />
                    <YAxis
                      tickFormatter={(value: number) => formatMoneyShort(value, "KES").replace("KES ", "")}
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      axisLine={false}
                      tickLine={false}
                      width={48}
                    />
                    <Tooltip
                      formatter={(value: number) => formatMoneyShort(value, "KES")}
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "0.75rem",
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line
                      type="monotone"
                      dataKey="rewards"
                      name="Rewards"
                      stroke="hsl(158 68% 42%)"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="referralCommissions"
                      name="Referral commissions"
                      stroke="hsl(43 90% 55%)"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>User growth and failed payments</CardTitle>
              <CardDescription>
                New registrations against deposits that did not complete.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(value: string) => value.slice(5)}
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      axisLine={false}
                      tickLine={false}
                      minTickGap={20}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      axisLine={false}
                      tickLine={false}
                      width={36}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "0.75rem",
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line
                      type="monotone"
                      dataKey="newUsers"
                      name="New users"
                      stroke="hsl(210 90% 60%)"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="failedPayments"
                      name="Failed payments"
                      stroke="hsl(0 72% 55%)"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
