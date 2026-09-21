import { requireAdmin } from "@/lib/auth/guards";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { WithdrawalsPanel } from "@/components/admin/withdrawals-panel";
import { Alert } from "@/components/ui/misc";
import { paymentProviderLabel, payoutReadiness } from "@/lib/payments/provider";

export const dynamic = "force-dynamic";

export default async function AdminWithdrawalsPage() {
  await requireAdmin();

  // The high-value threshold determines whether an approval also requires the
  // administrator to re-enter their password.
  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "withdrawals.high_value_threshold")
    .maybeSingle<{ value: unknown }>();

  const parsed = typeof data?.value === "number" ? data.value : Number(data?.value);
  const threshold = Number.isFinite(parsed) ? parsed : 10_000;

  // Whether an approval can actually pay out is decided by the same function
  // the approval route uses, so this screen cannot promise a payout the route
  // will refuse to send.
  const payout = payoutReadiness();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Withdrawals</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review each request before any money leaves the platform.
        </p>
      </div>

      <Alert variant="info" title="Payouts are never automatic">
        <p>
          {payout.canExecute ? (
            <>
              Approving a withdrawal initiates the provider disbursement and moves the request to
              PROCESSING. It is only marked COMPLETED once the provider confirms the payout. If the
              provider rejects or fails it, the held funds are returned to the user&apos;s available
              balance automatically.
            </>
          ) : (
            <>
              Approving a withdrawal records your decision and holds the funds. Nothing is sent and
              nothing is marked paid until the payment provider is configured.
            </>
          )}
        </p>
      </Alert>

      <WithdrawalsPanel
        highValueThreshold={threshold}
        payoutNotice={payout.canExecute ? null : payout.message}
        providerLabel={paymentProviderLabel()}
      />
    </div>
  );
}
