import { z } from "zod";
import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseQuery } from "@/lib/validation/parse";
import { getReportSeries, getReportTotals } from "@/server/services/admin";
import { getAdminDashboardStats, getPendingLiabilities } from "@/server/services/wallet";

const querySchema = z.object({
  days: z.coerce.number().int().min(7).max(365).default(30),
});

/**
 * GET /api/admin/reports?days=30
 *
 * Every figure is aggregated from real records — deposits, withdrawals, the
 * ledger and referral commissions. Nothing here is estimated or mocked.
 */
export async function GET(request: Request) {
  return runApi(async () => {
    await requireAdmin();
    const { days } = parseQuery(request.url, querySchema);

    const [series, totals, dashboard, liabilities] = await Promise.all([
      getReportSeries(days),
      getReportTotals(days),
      getAdminDashboardStats(),
      getPendingLiabilities(),
    ]);

    return ok({ days, series, totals, dashboard, liabilities });
  });
}
