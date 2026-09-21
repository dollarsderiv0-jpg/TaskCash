import { requireAdmin } from "@/lib/auth/guards";
import { DataTable } from "@/components/admin/data-table";
import { FraudReviewPanel } from "@/components/admin/fraud-review-panel";
import { Alert } from "@/components/ui/misc";

export const dynamic = "force-dynamic";

export default async function AdminFraudPage() {
  await requireAdmin();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Fraud review</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Signals raised by the anti-fraud layer. Nothing here acts on its own.
        </p>
      </div>

      <Alert variant="info" title="Signals inform a human decision">
        <p>
          A single weak signal never bans an account. Signals accumulate into a risk score, which
          places an account into this review queue. Restriction and suspension are explicit
          administrator actions and are recorded in the audit log with a reason.
        </p>
      </Alert>

      <DataTable
        title="Review queue"
        description="Severity indicates how much weight a signal carries, not a conclusion."
        variant="fraud"
        endpoint="/api/admin/fraud"
        statusOptions={[
          { value: "OPEN", label: "Open" },
          { value: "REVIEWING", label: "Reviewing" },
          { value: "CLEARED", label: "Cleared" },
          { value: "CONFIRMED", label: "Confirmed" },
        ]}
      />

      <FraudReviewPanel />
    </div>
  );
}
