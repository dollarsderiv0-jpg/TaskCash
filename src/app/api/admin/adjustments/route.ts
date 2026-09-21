import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { adminAdjustWalletSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

/**
 * POST /api/admin/adjustments
 *
 * A manual wallet adjustment is the most dangerous operation in the product,
 * so it is deliberately hard to perform: it requires a written reason, it is
 * written to the immutable ledger as ADMIN_ADJUSTMENT, and public.write_audit
 * records who did it. It also cannot push a balance negative.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const session = await requireAdmin();

    await enforceRateLimit(
      RATE_LIMITS.adminMutation.bucket,
      session.profile.id,
      RATE_LIMITS.adminMutation.limit,
      RATE_LIMITS.adminMutation.window,
      RATE_LIMITS.adminMutation.mode,
    );

    const body = await parseBody(request, adminAdjustWalletSchema);
    const admin = createAdminSupabaseClient();

    const { data, error } = await admin.rpc("admin_adjust_wallet", {
      p_admin_id: session.profile.id,
      p_user_id: body.userId,
      p_amount: body.amount,
      p_reason: body.reason,
    });

    if (error) throw error;

    return ok({
      transaction: data,
      message:
        "Adjustment recorded in the ledger. The user has been notified and the change is visible in the audit log.",
    });
  });
}
