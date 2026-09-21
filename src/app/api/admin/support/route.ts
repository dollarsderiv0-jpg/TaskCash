import { z } from "zod";
import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseQuery } from "@/lib/validation/parse";
import { countSupportByStatus, isSupportConfigured, listSupportQueue } from "@/server/services/support";

const querySchema = z.object({
  status: z.enum(["ALL", "OPEN", "IN_REVIEW", "RESOLVED", "CLOSED"]).default("ALL"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/**
 * GET /api/admin/support — the support queue.
 *
 * Administrator-only (server-side check, not a client flag). If migration 0006
 * has not been applied the queue is reported as unavailable rather than as an
 * empty list, because "no tickets" and "no support system" mean very different
 * things to the person reading it.
 */
export async function GET(request: Request) {
  return runApi(async () => {
    await requireAdmin();

    if (!(await isSupportConfigured())) {
      return ok({ configured: false, tickets: [], counts: {} });
    }

    const query = parseQuery(request.url, querySchema);
    const [tickets, counts] = await Promise.all([
      listSupportQueue({ status: query.status, limit: query.limit }),
      countSupportByStatus(),
    ]);

    return ok({ configured: true, tickets, counts });
  });
}
