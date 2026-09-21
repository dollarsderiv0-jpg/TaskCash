import { z } from "zod";
import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

/**
 * GET /api/admin/groups — list all WhatsApp groups
 * POST /api/admin/groups — create a new WhatsApp group
 */
export async function GET() {
  return runApi(async () => {
    await requireAdmin();

    const admin = createAdminSupabaseClient();
    const { data, error } = await admin
      .from("whatsapp_groups")
      .select("*")
      .order("sort_order", { ascending: true });

    if (error) throw error;

    return ok({ groups: data ?? [] });
  });
}

const createSchema = z.object({
  name: z.string().min(1).max(100),
  inviteLink: z.string().url("Please enter a valid WhatsApp group link"),
  sortOrder: z.number().int().min(0).default(0),
  userStart: z.number().int().min(0).default(0),
  userEnd: z.number().int().min(1).default(1000),
});

export async function POST(request: Request) {
  return runApi(async () => {
    const admin_user = await requireAdmin();
    const input = await parseBody(request, createSchema);

    const admin = createAdminSupabaseClient();

    const { data, error } = await admin
      .from("whatsapp_groups")
      .insert({
        name: input.name,
        invite_link: input.inviteLink,
        sort_order: input.sortOrder,
        user_start: input.userStart,
        user_end: input.userEnd,
      })
      .select("*")
      .single();

    if (error) throw error;

    await admin.rpc("write_audit", {
      p_admin_id: admin_user.authUserId,
      p_user_id: null,
      p_action: "WHATSAPP_GROUP_CREATED",
      p_entity: "whatsapp_group",
      p_entity_id: data.id,
      p_description: `Created WhatsApp group "${input.name}"`,
      p_metadata: { name: input.name, userStart: input.userStart, userEnd: input.userEnd },
      p_ip_hash: null,
      p_user_agent: null,
    });

    return ok({ group: data });
  });
}
