import { z } from "zod";
import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseQuery } from "@/lib/validation/parse";
import { listAdminDeposits } from "@/server/services/admin";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.string().max(40).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});

/** GET /api/admin/deposits */
export async function GET(request: Request) {
  return runApi(async () => {
    await requireAdmin();
    return ok(await listAdminDeposits(parseQuery(request.url, querySchema)));
  });
}
