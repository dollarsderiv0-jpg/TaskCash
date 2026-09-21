import { z } from "zod";
import { requireSessionUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getDepositById, verifyAndSettleDeposit } from "@/server/services/deposits";
import { getWalletOverview } from "@/server/services/wallet";
import { paymentStatusFromDepositStatus } from "@/lib/payments/status";
import { ApiError } from "@/lib/api/errors";

const schema = z.object({ depositId: z.string().uuid() });

/**
 * POST /api/deposits/verify
 *
 * Re-checks a deposit against the provider. This is what the "I have paid"
 * button calls. It is safe to press repeatedly: it is idempotent and can only
 * ever credit a deposit once.
 *
 * It is also the payment status endpoint for an STK push: the frontend polls
 * this to learn whether a payment is pending, successful, failed, cancelled or
 * unknown. `paymentStatus` is the stable contract — five lowercase words — while
 * `status` stays the internal record state for administration. `paymentStatus`
 * reads "successful" only for a COMPLETED deposit, which is only ever written
 * after the provider independently confirms the payment.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const session = await requireSessionUser();

    await enforceRateLimit("deposit:verify", session.profile.id, 30, 600, "open");

    const input = await parseBody(request, schema);
    const deposit = await getDepositById(input.depositId);

    if (!deposit) {
      throw new ApiError("DEPOSIT_NOT_FOUND", "That deposit could not be found.", 404);
    }
    // Ownership check: a user may only verify their own deposit.
    if (deposit.user_id !== session.profile.id) {
      throw new ApiError("FORBIDDEN", "You do not have access to that record.", 403);
    }

    const outcome = await verifyAndSettleDeposit(deposit);
    const overview = await getWalletOverview(session.profile.id);

    return ok({
      ...outcome,
      depositId: deposit.id,
      merchantReference: deposit.merchant_reference,
      paymentStatus: paymentStatusFromDepositStatus(outcome.status),
      availableBalance: overview?.wallet.available_balance ?? null,
    });
  });
}
