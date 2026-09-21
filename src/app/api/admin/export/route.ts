import { z } from "zod";
import { requireAdmin } from "@/lib/auth/guards";
import { runApi } from "@/lib/api/response";
import { parseQuery } from "@/lib/validation/parse";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { EXPORT_COLUMNS, toCsv } from "@/server/services/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

const querySchema = z.object({
  entity: z.enum([
    "users",
    "deposits",
    "withdrawals",
    "transactions",
    "video_rewards",
    "referral_commissions",
  ]),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  status: z.string().max(40).optional(),
});

const TABLE_BY_ENTITY: Record<string, { table: string; dateColumn: string }> = {
  users: { table: "profiles", dateColumn: "created_at" },
  deposits: { table: "deposits", dateColumn: "created_at" },
  withdrawals: { table: "withdrawals", dateColumn: "requested_at" },
  transactions: { table: "wallet_transactions", dateColumn: "created_at" },
  video_rewards: { table: "video_watch_sessions", dateColumn: "rewarded_at" },
  referral_commissions: { table: "referral_commissions", dateColumn: "created_at" },
};

/**
 * GET /api/admin/export?entity=withdrawals&from=...&to=...
 *
 * Exports real database records, capped at 10,000 rows per request so a single
 * export cannot exhaust memory. The admin audit trail records the export.
 */
export async function GET(request: Request) {
  return runApi(async () => {
    const session = await requireAdmin();
    const query = parseQuery(request.url, querySchema);

    const config = TABLE_BY_ENTITY[query.entity];
    if (!config) throw new ApiError("UNSUPPORTED_ENTITY", "That export is not supported.", 400);

    const admin = createAdminSupabaseClient();
    const columns = EXPORT_COLUMNS[query.entity];

    let dbQuery = admin
      .from(config.table)
      .select(columns.join(","))
      .order(config.dateColumn, { ascending: false })
      .limit(10_000);

    if (query.from) dbQuery = dbQuery.gte(config.dateColumn, query.from);
    if (query.to) dbQuery = dbQuery.lte(config.dateColumn, query.to);
    if (query.status && query.status !== "ALL") {
      dbQuery = dbQuery.eq(query.entity === "video_rewards" ? "status" : "status", query.status);
    }

    const { data, error } = await dbQuery;
    if (error) throw error;

    await admin.rpc("write_audit", {
      p_admin_id: session.profile.id,
      p_user_id: null,
      p_action: "DATA_EXPORT",
      p_entity: query.entity,
      p_entity_id: null,
      p_description: `Exported ${data?.length ?? 0} ${query.entity} record(s) as CSV`,
      p_metadata: { from: query.from ?? null, to: query.to ?? null, status: query.status ?? null },
      p_ip_hash: null,
      p_user_agent: null,
    });

    const csv = toCsv((data ?? []) as unknown as Record<string, unknown>[], columns);
    const filename = `taskcash-${query.entity}-${new Date().toISOString().slice(0, 10)}.csv`;

    logger.info("admin_export", { entity: query.entity, rows: data?.length ?? 0 });

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
