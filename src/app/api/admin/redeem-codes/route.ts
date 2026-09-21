import { z } from "zod";
import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";

/**
 * GET /api/admin/redeem-codes — list all redeem codes
 * POST /api/admin/redeem-codes — create a new redeem code
 */
export async function GET() {
  return runApi(async () => {
    await requireAdmin();

    const admin = createAdminSupabaseClient();
    const { data, error } = await admin
      .from("redeem_codes")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) throw error;

    return ok({ codes: data ?? [] });
  });
}

const createSchema = z.object({
  amount: z.number().positive("Amount must be positive"),
  maxRedemptions: z.number().int().positive().max(1000).default(5),
  expiresInHours: z.number().int().positive().max(720).optional(), // max 30 days
  count: z.number().int().positive().max(50).default(1), // batch create
});

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "TC";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export async function POST(request: Request) {
  return runApi(async () => {
    const admin_user = await requireAdmin();
    const input = await parseBody(request, createSchema);

    const admin = createAdminSupabaseClient();

    const batchCount = input.count ?? 1;
    const codes: { code: string; amount: number; max_redemptions: number; expires_at: string | null; created_by: string }[] = [];

    for (let i = 0; i < batchCount; i++) {
      codes.push({
        code: generateCode(),
        amount: input.amount,
        max_redemptions: input.maxRedemptions ?? 5,
        expires_at: input.expiresInHours
          ? new Date(Date.now() + input.expiresInHours * 3600_000).toISOString()
          : null,
        created_by: admin_user.authUserId ?? "",
      });
    }

    const { data, error } = await admin
      .from("redeem_codes")
      .insert(codes)
      .select("id, code, amount, max_redemptions, expires_at, status, created_at");

    if (error) {
      if (error.code === "23505") {
        throw new ApiError("CODE_DUPLICATE", "A duplicate code was generated. Please try again.", 409);
      }
      throw error;
    }

    await admin.rpc("write_audit", {
      p_admin_id: admin_user.authUserId,
      p_user_id: null,
      p_action: "REDEEM_CODES_CREATED",
      p_entity: "redeem_code",
      p_entity_id: null,
      p_description: `Created ${batchCount} redeem code(s) at ${input.amount} each`,
      p_metadata: { count: batchCount, amount: input.amount, maxRedemptions: input.maxRedemptions },
      p_ip_hash: null,
      p_user_agent: null,
    });

    return ok({ codes: data ?? [], count: data?.length ?? 0 });
  });
}
