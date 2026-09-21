import { requireAdmin } from "@/lib/auth/guards";
import { DataTable } from "@/components/admin/data-table";
import { CreateAdminPanel } from "@/components/admin/create-admin-panel";
import { Alert } from "@/components/ui/misc";

export const dynamic = "force-dynamic";

export default async function AdminReferralsPage() {
  await requireAdmin();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Referrals</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every referral commission created, with the rate that was applied when it was issued.
        </p>
      </div>

      <Alert variant="info" title="Commission integrity">
        <p>
          Commission rates are configured in Settings and are captured on each commission record at
          creation time, so changing a rate never rewrites history. A unique database constraint
          prevents the same qualifying event from paying twice.
        </p>
      </Alert>

      <DataTable
        title="Referral commissions"
        variant="referrals"
        endpoint="/api/admin/referrals"
        exportEntity="referral_commissions"
        statusOptions={[
          { value: "CREDITED", label: "Credited" },
          { value: "PENDING", label: "Pending" },
          { value: "REVERSED", label: "Reversed" },
        ]}
      />

      <CreateAdminPanel />
    </div>
  );
}
