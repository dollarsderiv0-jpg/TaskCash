import { z } from "zod";
import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody, parseQuery } from "@/lib/validation/parse";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { requestContext } from "@/lib/api/context";
import { listReconciliationAlerts } from "@/server/services/admin";
import { getDepositById, verifyAndSettleDeposit } from "@/server/services/deposits";
import { settleWithdrawalFromProvider } from "@/server/services/withdrawals";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.string().max(40).optional(),
});

const settleSchema = z.object({
  entity: z.enum(["deposit", "withdrawal"]),
  id: z.string().uuid(),
  alertId: z.string().uuid().optional(),
});

/** GET /api/admin/reconciliation — mismatches and unresolved payments. */
export async function GET(request: Request) {
  return runApi(async () => {
    await requireAdmin();
    return ok(await listReconciliationAlerts(parseQuery(request.url, querySchema)));
  });
}

/**
 * POST /api/admin/reconciliation
 *
 * Re-runs the authoritative verification for one record. Both settlement
 * functions are idempotent, so pressing this button repeatedly cannot
 * double-credit a deposit or double-pay a withdrawal.
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

    const body = await parseBody(request, settleSchema);
    const admin = createAdminSupabaseClient();

    let result: { status: string; message: string };

    if (body.entity === "deposit") {
      const deposit = await getDepositById(body.id);
      if (!deposit) throw new ApiError("DEPOSIT_NOT_FOUND", "That deposit could not be found.", 404);
      const outcome = await verifyAndSettleDeposit(deposit);
      result = { status: outcome.status, message: outcome.message };
    } else {
      result = await settleWithdrawalFromProvider(body.id);
    }

    if (body.alertId) {
      await admin
        .from("reconciliation_alerts")
        .update({
          status: "RESOLVED",
          resolved_by: session.profile.id,
          resolved_at: new Date().toISOString(),
        })
        .eq("id", body.alertId);
    }

    await admin.rpc("write_audit", {
      p_admin_id: session.profile.id,
      p_user_id: null,
      p_action: "RECONCILIATION_RUN",
      p_entity: body.entity,
      p_entity_id: body.id,
      p_description: `Reconciliation run resulted in ${result.status}`,
      p_metadata: { result: result.message },
      p_ip_hash: ctx.ipHash,
      p_user_agent: ctx.userAgent,
    });

    return ok(result);
  });
}
