import { requireSessionUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseQuery } from "@/lib/validation/parse";
import { listWalletTransactions } from "@/server/services/wallet";
import { z } from "zod";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  type: z
    .enum([
      "DEPOSIT",
      "VIDEO_REWARD",
      "TASK_REWARD",
      "REFERRAL_REWARD",
      "WITHDRAWAL_HOLD",
      "WITHDRAWAL",
      "WITHDRAWAL_FEE",
      "WITHDRAWAL_RELEASE",
      "REFUND",
      "REVERSAL",
      "ADMIN_ADJUSTMENT",
    ])
    .optional(),
  status: z
    .enum(["PENDING", "PROCESSING", "COMPLETED", "FAILED", "REJECTED", "CANCELLED", "REVERSED"])
    .optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/** GET /api/wallet/transactions — the immutable ledger, newest first. */
export async function GET(request: Request) {
  return runApi(async () => {
    const session = await requireSessionUser();
    const query = parseQuery(request.url, querySchema);

    const result = await listWalletTransactions(session.profile.id, {
      page: query.page,
      pageSize: query.pageSize,
      type: query.type ?? null,
      status: query.status ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
    });

    return ok(result);
  });
}
