"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/fields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * CSV export.
 *
 * Exports are generated server-side from real records, capped at 10,000 rows,
 * and every export is written to the audit log with the filters that produced
 * it.
 */

const ENTITIES = [
  { value: "users", label: "Users" },
  { value: "deposits", label: "Deposits" },
  { value: "withdrawals", label: "Withdrawals" },
  { value: "transactions", label: "Wallet transactions" },
  { value: "video_rewards", label: "Video rewards" },
  { value: "referral_commissions", label: "Referral commissions" },
];

export function ReportExportPanel() {
  const [entity, setEntity] = React.useState("withdrawals");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [status, setStatus] = React.useState("");

  const href = React.useMemo(() => {
    const params = new URLSearchParams({ entity });
    // Date inputs are local dates; convert to an ISO instant for the query.
    if (from) params.set("from", new Date(`${from}T00:00:00`).toISOString());
    if (to) params.set("to", new Date(`${to}T23:59:59`).toISOString());
    if (status) params.set("status", status);
    return `/api/admin/export?${params.toString()}`;
  }, [entity, from, to, status]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export records</CardTitle>
        <CardDescription>
          Downloads a CSV of the real records matching your filters. Maximum 10,000 rows per export.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Dataset" htmlFor="exportEntity">
            <Select id="exportEntity" value={entity} onChange={(e) => setEntity(e.target.value)}>
              {ENTITIES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From" htmlFor="exportFrom">
            <Input id="exportFrom" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To" htmlFor="exportTo">
            <Input id="exportTo" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Status filter" htmlFor="exportStatus" hint="Leave empty for all statuses.">
            <Input
              id="exportStatus"
              value={status}
              onChange={(e) => setStatus(e.target.value.toUpperCase())}
              placeholder="e.g. COMPLETED"
            />
          </Field>
        </div>

        <Button asChild>
          <a href={href}>
            <Download className="h-4 w-4" aria-hidden />
            Download CSV
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}
