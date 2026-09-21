import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody, parseInput } from "@/lib/validation/parse";
import { adminRejectWithdrawalSchema, idSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { requestContext } from "@/lib/api/context";
import { rejectWithdrawal } from "@/server/services/withdrawals";

/**
 * POST /api/admin/withdrawals/:id/reject
 *
 * Releases the held funds back to the user's available balance and records the
 * rejection with a mandatory reason.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return runApi(async () => {
    const session = await requireAdmin();
    const reqCtx = requestContext(request);

    await enforceRateLimit(
      RATE_LIMITS.adminMutation.bucket,
      session.profile.id,
      RATE_LIMITS.adminMutation.limit,
      RATE_LIMITS.adminMutation.window,
      RATE_LIMITS.adminMutation.mode,
    );

    const { id } = await ctx.params;
    const withdrawalId = parseInput(idSchema, id);
    const body = await parseBody(request, adminRejectWithdrawalSchema);

    const result = await rejectWithdrawal({
      withdrawalId,
      adminId: session.profile.id,
      reason: body.reason,
      ipHash: reqCtx.ipHash,
      userAgent: reqCtx.userAgent,
    });

    return ok({ ...result, withdrawalId });
  });
}
