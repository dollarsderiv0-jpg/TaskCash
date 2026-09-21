"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/fields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";

/**
 * Manual wallet adjustment.
 *
 * This is the most sensitive operation in the product. It requires a written
 * reason, it is written to the immutable ledger as an ADMIN_ADJUSTMENT, it is
 * attributed to the signed-in administrator, and the affected user is notified.
 */
export function CreateAdminPanel() {
  const router = useRouter();
  const { toast } = useToast();

  const [userId, setUserId] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  const numeric = Number(amount);
  const valid = Number.isFinite(numeric) && numeric !== 0 && reason.trim().length >= 5 && userId.length > 0;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!confirming) {
      setConfirming(true);
      return;
    }

    setLoading(true);
    const response = await apiRequest<{ message: string }>("/api/admin/adjustments", {
      method: "POST",
      body: { userId, amount: numeric, reason: reason.trim() },
    });
    setLoading(false);
    setConfirming(false);

    if (!response.ok) {
      toast({ title: "Adjustment failed", description: response.message, tone: "error" });
      return;
    }

    toast({ title: "Adjustment recorded", description: response.data.message, tone: "success" });
    setUserId("");
    setAmount("");
    setReason("");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Manual wallet adjustment</CardTitle>
        <CardDescription>
          Credits or debits a wallet with an auditable ledger entry. Use a negative amount to debit.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <Alert variant="warning" title="This moves real money">
            <p>
              The adjustment appears immediately in the user&apos;s wallet and ledger. It cannot be
              pushed below zero, and it is permanently attributed to you in the audit log.
            </p>
          </Alert>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="User ID" htmlFor="adjustUserId">
              <Input
                id="adjustUserId"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="uuid"
                required
              />
            </Field>
            <Field
              label="Amount"
              htmlFor="adjustAmount"
              hint="Positive credits, negative debits. Use the wallet currency."
            >
              <Input
                id="adjustAmount"
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. -150 or 150"
                required
              />
            </Field>
          </div>

          <Field label="Reason" htmlFor="adjustReason" hint="Recorded permanently with the entry.">
            <Textarea
              id="adjustReason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="For example: correction of a duplicated deposit confirmed by provider reference …"
              required
            />
          </Field>

          <Button type="submit" variant={confirming ? "destructive" : "default"} loading={loading} disabled={!valid}>
            {confirming ? "Confirm adjustment" : "Review adjustment"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
