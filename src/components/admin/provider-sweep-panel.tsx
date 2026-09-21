"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/client/api";

/**
 * The provider-side sweep, run on demand.
 *
 * The rest of this page asks the provider about records we already hold. This
 * asks the opposite question — what did the provider take that we never recorded
 * — and it is the only place that can find a payment with no local deposit at
 * all. It never credits anything: findings land as alerts below, for settlement
 * by hand.
 */

type SweepSummary = {
  skipped: boolean;
  reason?: string;
  provider: string;
  providerTransactionsRead: number;
  unreadableRows: number;
  formatUnrecognised: boolean;
  envelope: string;
  missingLocal: number;
  settled: number;
  amountMismatch: number;
  notCredited: number;
  alertsRaised: number;
  alertsAlreadyOpen: number;
  issues: string[];
};

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export function ProviderSweepPanel() {
  const router = useRouter();
  const { toast } = useToast();
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<SweepSummary | null>(null);

  async function run() {
    setLoading(true);
    const response = await apiRequest<SweepSummary>("/api/admin/reconciliation/sweep", {
      method: "POST",
    });
    setLoading(false);

    if (!response.ok) {
      toast({ title: "Sweep failed", description: response.message, tone: "error" });
      return;
    }

    setResult(response.data);
    router.refresh();

    if (response.data.skipped) {
      toast({
        title: "Sweep did not run",
        description: response.data.reason ?? "The provider could not be read.",
        tone: "info",
      });
      return;
    }

    const found =
      response.data.missingLocal +
      response.data.amountMismatch +
      response.data.notCredited;

    toast({
      title: found > 0 ? `${found} payment(s) need attention` : "No uncredited payments found",
      description:
        found > 0
          ? `${response.data.alertsRaised} new alert(s) raised below.`
          : `${response.data.providerTransactionsRead} provider transaction(s) checked.`,
      tone: found > 0 ? "error" : "success",
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sweep the provider</CardTitle>
        <CardDescription>
          Ask the provider what it took, and report any payment our ledger never credited.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant="info">
          <p>
            This runs the provider&rsquo;s own transaction list against our records — the one
            direction that can find a payment we hold no deposit for at all. It reports such
            payments here for manual settlement; it never credits a wallet on its own.
          </p>
        </Alert>

        <Button type="button" onClick={run} loading={loading}>
          <Radar className="h-4 w-4" aria-hidden />
          Run provider sweep
        </Button>

        {result ? (
          result.skipped ? (
            <Alert variant="warning" title="The sweep did not run">
              <p>{result.reason}</p>
            </Alert>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <Figure label="Provider rows read" value={result.providerTransactionsRead} />
                <Figure label="Paid, no local deposit" value={result.missingLocal} />
                <Figure label="Paid, amount differs" value={result.amountMismatch} />
                <Figure label="Paid, we said failed" value={result.notCredited} />
                <Figure label="New alerts" value={result.alertsRaised} />
              </div>

              {result.settled > 0 ? (
                <p className="text-sm text-muted-foreground">
                  {result.settled} open deposit(s) were confirmed paid and settled through the normal
                  verified path.
                </p>
              ) : null}

              {result.issues.length > 0 ? (
                <Alert variant="warning" title="The sweep was not complete">
                  <ul className="list-disc space-y-1 pl-4">
                    {result.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
