"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/fields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";

/**
 * Manual reconciliation.
 *
 * Re-runs the same authoritative verification used everywhere else. Both
 * settlement paths are idempotent, so this can be pressed repeatedly without
 * risking a double credit or a double payout.
 */
export function ReconciliationPanel() {
  const router = useRouter();
  const { toast } = useToast();

  const [entity, setEntity] = React.useState<"deposit" | "withdrawal">("deposit");
  const [id, setId] = React.useState("");
  const [alertId, setAlertId] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  async function run(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);

    const response = await apiRequest<{ status: string; message: string }>(
      "/api/admin/reconciliation",
      {
        method: "POST",
        body: { entity, id, alertId: alertId || undefined },
      },
    );

    setLoading(false);

    if (!response.ok) {
      toast({ title: "Reconciliation failed", description: response.message, tone: "error" });
      return;
    }

    toast({
      title: `Result: ${response.data.status}`,
      description: response.data.message,
      tone: response.data.status === "COMPLETED" ? "success" : "info",
    });

    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Re-check a record</CardTitle>
        <CardDescription>
          Ask the provider for the current status of one deposit or withdrawal.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={run} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Record type" htmlFor="entity">
              <Select
                id="entity"
                value={entity}
                onChange={(e) => setEntity(e.target.value as "deposit" | "withdrawal")}
              >
                <option value="deposit">Deposit</option>
                <option value="withdrawal">Withdrawal</option>
              </Select>
            </Field>
            <Field label="Record ID" htmlFor="recordId" hint="The UUID of the record.">
              <Input
                id="recordId"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="uuid"
                required
              />
            </Field>
            <Field label="Alert ID (optional)" htmlFor="alertId" hint="Marks the alert resolved.">
              <Input
                id="alertId"
                value={alertId}
                onChange={(e) => setAlertId(e.target.value)}
                placeholder="uuid"
              />
            </Field>
          </div>

          <Alert variant="warning">
            <p>
              If the provider still cannot confirm the transaction, nothing moves. The record stays
              pending and the alert remains open — we never credit or pay on an assumption.
            </p>
          </Alert>

          <Button type="submit" loading={loading} disabled={!id}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Run reconciliation
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
