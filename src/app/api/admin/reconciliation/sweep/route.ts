import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { requestContext } from "@/lib/api/context";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { sweepProviderPayments } from "@/server/services/reconciliation";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/reconciliation/sweep
 *
 * Runs the provider-side sweep on demand and reports what it found.
 *
 * This is the *inverse* direction to the rest of the reconciliation page: rather
 * than asking the provider about a record we already hold, it pulls the
 * provider's transaction list and reports payments the provider shows as paid
 * that our ledger never credited — including payments we hold no deposit for at
 * all. Those are reported as alerts for manual settlement, never credited
 * automatically, because a payment with no local deposit has no wallet to credit.
 *
 * Running it by hand never moves money on its own: a paid transaction with an
 * open deposit is handed to the ordinary verified settlement path, which credits
 * at most once.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const session = await requireAdmin();
    const ctx = requestContext(request);

    await enforceRateLimit(
      RATE_LIMITS.adminMutation.bucket,
      session.profile.id,
      RATE_LIMITS.adminMutation.limit,
      RATE_LIMITS.adminMutation.window,
      RATE_LIMITS.adminMutation.mode,
    );

    const summary = await sweepProviderPayments();
    const admin = createAdminSupabaseClient();

    await admin.rpc("write_audit", {
      p_admin_id: session.profile.id,
      p_user_id: null,
      p_action: "PROVIDER_RECONCILIATION_SWEEP",
      p_entity: "reconciliation",
      p_entity_id: null,
      p_description: summary.skipped
        ? "Provider sweep did not run"
        : `Provider sweep read ${summary.providerTransactionsRead} transaction(s) and raised ` +
          `${summary.alertsRaised} alert(s)`,
      p_metadata: {
        provider: summary.provider,
        skipped: summary.skipped,
        reason: summary.reason ?? null,
        settled: summary.settled,
        missingLocal: summary.missingLocal,
        amountMismatch: summary.amountMismatch,
        notCredited: summary.notCredited,
        alertsRaised: summary.alertsRaised,
        alertsAlreadyOpen: summary.alertsAlreadyOpen,
        issues: summary.issues,
      },
      p_ip_hash: ctx.ipHash,
      p_user_agent: ctx.userAgent,
    });

    return ok(summary);
  });
}
