import { requireAdmin } from "@/lib/auth/guards";
import { DataTable } from "@/components/admin/data-table";
import { ReconciliationPanel } from "@/components/admin/reconciliation-panel";
import { ProviderSweepPanel } from "@/components/admin/provider-sweep-panel";
import { Alert } from "@/components/ui/misc";

export const dynamic = "force-dynamic";

export default async function AdminReconciliationPage() {
  await requireAdmin();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Reconciliation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Mismatches between our records and the payment provider.
        </p>
      </div>

      <Alert variant="info" title="How mismatches are handled">
        <p>
          A callback from the provider is treated as a hint, never as proof. Every settlement re-asks
          the provider for the authoritative transaction status first, so a payment that cannot be
          confirmed stays pending and raises an alert here instead of being credited on assumption.
          The provider sweep below adds the other direction: a payment the provider shows as paid
          that we hold no credit for, which is reported here for settlement by hand.
        </p>
      </Alert>

      <ProviderSweepPanel />

      <DataTable
        title="Alerts"
        variant="reconciliation"
        endpoint="/api/admin/reconciliation"
        statusOptions={[
          { value: "OPEN", label: "Open" },
          { value: "RESOLVED", label: "Resolved" },
          { value: "IGNORED", label: "Ignored" },
        ]}
      />

      <ReconciliationPanel />
    </div>
  );
}
