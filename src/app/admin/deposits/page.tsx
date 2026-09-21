import { requireAdmin } from "@/lib/auth/guards";
import { DataTable } from "@/components/admin/data-table";

export const dynamic = "force-dynamic";

export default async function AdminDepositsPage() {
  await requireAdmin();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Deposits</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Collections requested through our payment partner. A deposit is only credited after the
          provider confirms it.
        </p>
      </div>

      <DataTable
        title="Deposit records"
        description="Search by reference, or filter by status. Export produces the exact records shown."
        variant="deposits"
        endpoint="/api/admin/deposits"
        exportEntity="deposits"
        statusOptions={[
          { value: "PENDING", label: "Pending" },
          { value: "PROCESSING", label: "Processing" },
          { value: "COMPLETED", label: "Completed" },
          { value: "FAILED", label: "Failed" },
          { value: "CANCELLED", label: "Cancelled" },
          { value: "REJECTED", label: "Rejected" },
        ]}
      />
    </div>
  );
}
