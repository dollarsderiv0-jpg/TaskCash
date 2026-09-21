import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { AppNotification } from "@/lib/types";

/**
 * Creates a notification for a user.
 *
 * Uses the service-role client on purpose: the notifications table has no
 * INSERT policy, so a signed-in user cannot write their own notifications —
 * only trusted server code can. Titles and messages are written for the person
 * reading them, never as raw status codes.
 */
export async function notifyUser(input: {
  userId: string;
  type: string;
  title: string;
  message: string;
  severity?: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  link?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const admin = createAdminSupabaseClient();
  const { error } = await admin.rpc("notify_user", {
    p_user_id: input.userId,
    p_type: input.type,
    p_title: input.title,
    p_message: input.message,
    p_severity: input.severity ?? "INFO",
    p_link: input.link ?? null,
    p_metadata: input.metadata ?? {},
  });

  if (error) throw error;
}

export async function listNotifications(userId: string, limit = 50): Promise<AppNotification[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as AppNotification[];
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  const supabase = await createServerSupabaseClient();
  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("read_at", null);

  return count ?? 0;
}

/** Row level security restricts this update to the caller's own rows. */
export async function markNotificationsRead(userId: string, ids?: string[]): Promise<number> {
  const supabase = await createServerSupabaseClient();
  let query = supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("read_at", null);

  if (ids && ids.length > 0) {
    query = query.in("id", ids);
  }

  const { data, error } = await query.select("id");
  if (error) throw error;
  return (data ?? []).length;
}
