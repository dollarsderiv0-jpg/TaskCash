import { requireAdmin } from "@/lib/auth/guards";
import { DataTable } from "@/components/admin/data-table";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  await requireAdmin();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Users</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Account status, verification and risk. Status changes are made from the fraud review screen
          so every change is recorded with a reason.
        </p>
      </div>

      <DataTable
        title="User directory"
        description="Search by name, email, phone or referral code."
        variant="users"
        endpoint="/api/admin/users"
        exportEntity="users"
        statusOptions={[
          { value: "ACTIVE", label: "Active" },
          { value: "PENDING", label: "Pending" },
          { value: "RESTRICTED", label: "Restricted" },
          { value: "SUSPENDED", label: "Suspended" },
          { value: "CLOSED", label: "Closed" },
        ]}
      />
    </div>
  );
}
