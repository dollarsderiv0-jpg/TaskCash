import { z } from "zod";
import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseQuery } from "@/lib/validation/parse";
import { listAuditLogs } from "@/server/services/admin";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().max(120).optional(),
});

/** GET /api/admin/audit-logs — who approved, rejected or changed what. */
export async function GET(request: Request) {
  return runApi(async () => {
    await requireAdmin();
    return ok(await listAuditLogs(parseQuery(request.url, querySchema)));
  });
}
