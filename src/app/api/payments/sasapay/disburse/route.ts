import { z } from "zod";
import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { requestContext } from "@/lib/api/context";
import { approveWithdrawal, settleWithdrawalFromProvider } from "@/server/services/withdrawals";

const schema = z.object({
  withdrawalId: z.string().uuid(),
  /**
   * "settle" re-checks an in-flight payout against the provider.
   * "approve" initiates the payout for a pending request.
   */
  action: z.enum(["approve", "settle"]),
});

/**
 * POST /api/payments/sasapay/disburse
 *
 * ADMIN ONLY. There is no user-reachable path to a disbursement: this route
 * requires an authenticated administrator whose role is re-read from the
 * database on every call.
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

    const input = await parseBody(request, schema);

    if (input.action === "settle") {
      const result = await settleWithdrawalFromProvider(input.withdrawalId);
      return ok(result);
    }

    const result = await approveWithdrawal({
      withdrawalId: input.withdrawalId,
      adminId: session.profile.id,
      adminEmail: session.profile.email,
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    });

    return ok(result);
  });
}
