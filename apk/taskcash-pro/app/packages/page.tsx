"use client";

import * as React from "react";
import { Info } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { PackageTable } from "@/components/package-table";
import { PurchaseModal } from "@/components/purchase-modal";
import { formatMoneyCompact, formatNumber } from "@/lib/format";
import {
  MAX_NET_PROFIT,
  MAX_NET_RETURN_PCT,
  PACKAGES,
  STARTING_PACKAGE,
  TOP_TIER_PACKAGE,
} from "@/lib/mock-data";
import { useStore } from "@/lib/store";
import type { Package } from "@/lib/types";

export default function PackagesPage() {
  const { activePackages } = useStore();
  const [selected, setSelected] = React.useState<Package | null>(null);
  const ownedIds = activePackages.map((p) => p.packageId);

  const summaries = [
    {
      label: "Starting package",
      value: formatMoneyCompact(STARTING_PACKAGE.price),
      detail: `${STARTING_PACKAGE.days} Days | ${STARTING_PACKAGE.tasksPerDay} Tasks/Day`,
      tone: "text-white",
    },
    {
      label: "Top tier package",
      value: formatMoneyCompact(TOP_TIER_PACKAGE.price),
      detail: `${TOP_TIER_PACKAGE.days} Days | ${TOP_TIER_PACKAGE.tasksPerDay} Tasks/Day`,
      tone: "text-white",
    },
    {
      label: "Max net profit",
      value: formatMoneyCompact(MAX_NET_PROFIT),
      detail: `+${formatNumber(MAX_NET_RETURN_PCT)}% Net Return`,
      tone: "text-cash",
    },
  ];

  return (
    <AppShell>
      <PageHeader
        title="Packages"
        subtitle="Pick a tier to unlock its daily watch tasks. Every figure below comes from the published tier row."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        {summaries.map((summary) => (
          <div key={summary.label} className="tc-card p-4">
            <p className="tc-label">{summary.label}</p>
            <p className={`tc-value mt-1.5 text-2xl ${summary.tone}`}>{summary.value}</p>
            <p className="mt-1 text-[11px] text-muted">{summary.detail}</p>
          </div>
        ))}
      </div>

      <section className="mt-5" aria-labelledby="performance-table">
        <h2
          id="performance-table"
          className="mb-3 flex items-center gap-2.5 text-[15px] font-bold tracking-tight text-white"
        >
          <span aria-hidden className="h-4 w-1 rounded-full bg-brand" />
          Package Performance Table
        </h2>

        <PackageTable packages={PACKAGES} ownedIds={ownedIds} onBuy={setSelected} />
      </section>

      <div className="mt-4 flex items-start gap-2.5 rounded-tile border border-hairline bg-card/60 px-3.5 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" aria-hidden />
        <p className="text-[11px] leading-relaxed text-muted">
          Figures show the maximum a tier can pay out if every daily task is completed for the full
          duration. Earnings depend on eligible campaigns and available campaign budgets — there are
          no guaranteed returns.
        </p>
      </div>

      <PurchaseModal pkg={selected} onClose={() => setSelected(null)} />
    </AppShell>
  );
}
