import { requireSessionUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { getWalletOverview, getEarningsSummary } from "@/server/services/wallet";
import { getWithdrawalPreview } from "@/server/services/withdrawals";

/**
 * GET /api/wallet
 *
 * Balances are read from the database, never computed in the browser.
 */
export async function GET() {
  return runApi(async () => {
    const session = await requireSessionUser();

    const [overview, earnings, withdrawalPreview] = await Promise.all([
      getWalletOverview(session.profile.id),
      getEarningsSummary(session.profile.id),
      getWithdrawalPreview({ profile: session.profile, wallet: session.wallet }),
    ]);

    return ok({ overview, earnings, withdrawalPreview });
  });
}
