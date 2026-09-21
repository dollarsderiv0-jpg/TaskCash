import { requireSessionUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { getWithdrawalPreview, listUserWithdrawals } from "@/server/services/withdrawals";

/** GET /api/withdrawals — this user's withdrawals plus current limits. */
export async function GET() {
  return runApi(async () => {
    const session = await requireSessionUser();
    const [withdrawals, preview] = await Promise.all([
      listUserWithdrawals(session.profile.id, 50),
      getWithdrawalPreview({ profile: session.profile, wallet: session.wallet }),
    ]);

    return ok({ withdrawals, preview });
  });
}
