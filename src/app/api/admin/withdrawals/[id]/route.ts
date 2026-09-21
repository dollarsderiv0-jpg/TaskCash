import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { getWithdrawalContext } from "@/server/services/admin";
import { idSchema } from "@/lib/validation/schemas";
import { parseInput } from "@/lib/validation/parse";

/** GET /api/admin/withdrawals/:id — the full review context for one request. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  return runApi(async () => {
    await requireAdmin();
    const { id } = await ctx.params;
    const withdrawalId = parseInput(idSchema, id);
    return ok(await getWithdrawalContext(withdrawalId));
  });
}
