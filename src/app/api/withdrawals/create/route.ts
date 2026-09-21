import { requireVerifiedUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { withdrawalCreateSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { createWithdrawal } from "@/server/services/withdrawals";
import { getWalletOverview } from "@/server/services/wallet";

/**
 * POST /api/withdrawals/create
 *
 * Reserves funds (available -> locked) and creates a PENDING_ADMIN_APPROVAL
 * request. No money is sent to the provider here: a human administrator must
 * approve it first. Every eligibility rule is enforced inside
 * public.withdrawal_reserve().
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const session = await requireVerifiedUser("withdrawals.create");
    await enforceRateLimit(
      RATE_LIMITS.withdrawalCreate.bucket,
      session.profile.id,
      RATE_LIMITS.withdrawalCreate.limit,
      RATE_LIMITS.withdrawalCreate.window,
      RATE_LIMITS.withdrawalCreate.mode,
    );

    const input = await parseBody(request, withdrawalCreateSchema);

    const result = await createWithdrawal({
      profile: session.profile,
      wallet: session.wallet,
      amount: input.amount,
      phone: input.phone,
      idempotencyKey: input.idempotencyKey,
    });

    const overview = await getWalletOverview(session.profile.id);

    return ok({
      ...result,
      availableBalance: overview?.wallet.available_balance ?? null,
      lockedBalance: overview?.wallet.locked_balance ?? null,
      note:
        "Withdrawals are reviewed by the TaskCash Pro administration team before payment is sent. " +
        "You will be notified as soon as the status changes.",
    });
  });
}
