import { requireSessionUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { enforceRateLimit } from "@/lib/rate-limit";
import { processPendingRewards } from "@/server/services/videos";
import { getWalletOverview } from "@/server/services/wallet";

/**
 * POST /api/rewards/process
 *
 * Recovery endpoint: settles any watch session where the user already satisfied
 * the required watch time but the client never called /videos/complete (app
 * closed, network dropped, phone locked). It re-runs the same authoritative
 * completion function, so a session can still only ever be rewarded once.
 */
export async function POST() {
  return runApi(async () => {
    const session = await requireSessionUser();

    await enforceRateLimit("rewards:process", session.profile.id, 10, 600, "open");

    const result = await processPendingRewards(session.profile.id);
    const overview = await getWalletOverview(session.profile.id);

    return ok({
      ...result,
      availableBalance: overview?.wallet.available_balance ?? null,
      message:
        result.credited > 0
          ? `${result.credited} pending reward(s) were verified and credited.`
          : "No pending rewards needed processing.",
    });
  });
}
