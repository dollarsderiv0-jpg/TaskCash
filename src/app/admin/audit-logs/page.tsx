import { requireAdmin } from "@/lib/auth/guards";
import { DataTable } from "@/components/admin/data-table";

export const dynamic = "force-dynamic";

export default async function AdminAuditLogsPage() {
  await requireAdmin();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Audit logs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Who approved a withdrawal, who changed a rate, who adjusted a wallet, who suspended an
          account.
        </p>
      </div>

      <DataTable
        title="Audit trail"
        description="Search by action name, for example WITHDRAWAL_APPROVED."
        variant="audit"
        endpoint="/api/admin/audit-logs"
      />
    </div>
  );
}
