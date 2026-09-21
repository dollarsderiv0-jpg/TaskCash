"use client";

import * as React from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState } from "@/components/ui/misc";
import { formatMoneyShort } from "@/lib/money/format";

/**
 * Earnings trend.
 *
 * This chart only ever plots recorded ledger credits for the signed-in user.
 */
export function EarningsChart({
  data,
  currency,
}: {
  data: { date: string; amount: number }[];
  currency: string;
}) {
  const hasAny = data.some((point) => point.amount > 0);

  if (!hasAny) {
    return (
      <EmptyState
        title="No earnings recorded yet"
        description="Complete an eligible campaign and your daily rewards will chart here."
        className="py-8"
      />
    );
  }

  // Recharts needs a stable width; a ResizeObserver-backed container keeps it
  // responsive without hardcoding a pixel width.
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="earnings-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(158 68% 42%)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="hsl(158 68% 42%)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(value: string) => value.slice(5)}
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis
            tickFormatter={(value: number) => formatMoneyShort(value, currency).replace(`${currency} `, "")}
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
            width={44}
          />
          <Tooltip
            formatter={(value: number) => [formatMoneyShort(value, currency), "Rewards"]}
            labelFormatter={(label: string) => label}
            contentStyle={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "0.75rem",
              fontSize: 12,
              color: "hsl(var(--popover-foreground))",
            }}
          />
          <Area
            type="monotone"
            dataKey="amount"
            stroke="hsl(158 68% 42%)"
            strokeWidth={2}
            fill="url(#earnings-fill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
