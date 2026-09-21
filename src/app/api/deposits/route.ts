import { requireSessionUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { listUserDeposits } from "@/server/services/deposits";

/** GET /api/deposits — this user's deposit records. */
export async function GET() {
  return runApi(async () => {
    const session = await requireSessionUser();
    const deposits = await listUserDeposits(session.profile.id, 50);
    return ok({ deposits });
  });
}
