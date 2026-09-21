import { requireAdmin } from "@/lib/auth/guards";
import { DataTable } from "@/components/admin/data-table";

export const dynamic = "force-dynamic";

export default async function AdminTransactionsPage() {
  await requireAdmin();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Transactions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The immutable wallet ledger. Entries are append-only — they cannot be edited or deleted,
          which is what makes the balances auditable.
        </p>
      </div>

      <DataTable
        title="Wallet ledger"
        description="Search by reference. Every row is a real money movement with its balance effect."
        variant="transactions"
        endpoint="/api/admin/transactions"
        exportEntity="transactions"
        statusOptions={[
          { value: "COMPLETED", label: "Completed" },
          { value: "PENDING", label: "Pending" },
          { value: "PROCESSING", label: "Processing" },
          { value: "FAILED", label: "Failed" },
          { value: "REVERSED", label: "Reversed" },
        ]}
      />
    </div>
  );
}
