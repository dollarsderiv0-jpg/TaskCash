import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { isMissingSchemaFailure } from "@/lib/api/errors";
import type { SupportMessage, SupportTicket, SupportTicketStatus } from "@/lib/types";

/**
 * Support reads and writes.
 *
 * Tickets are created and replied to through SECURITY DEFINER functions that
 * derive the caller's identity from auth.uid() — never from a parameter — so a
 * user cannot open or reply to a ticket belonging to someone else, and cannot
 * set their own status, priority or assigned admin.
 *
 * `isSupportConfigured()` exists because the support tables arrive in migration
 * 0006, which is applied separately. The public support page still works
 * without it (help content, FAQ, contact channels); only the ticket form is
 * withheld, and it appears by itself the moment the migration is applied. That
 * is honest degradation rather than a form that always fails.
 */

export async function isSupportConfigured(): Promise<boolean> {
  const supabase = await createServerSupabaseClient();

  /*
    A plain `select ... limit 1`, deliberately NOT a `head: true` count probe.

    PostgREST answers a failed HEAD request with a bare 401 and an EMPTY error
    message, because a HEAD response has nowhere to put the error body. That made
    a missing-schema check indistinguishable from a permission failure or a
    network fault, and the caller rethrew it — a 500 on a public help page.
    One row is all this needs, and a normal GET reports the error honestly.
  */
  const { error } = await supabase.from("support_tickets").select("id").limit(1);

  if (!error) return true;
  if (isMissingSchemaFailure(error)) return false;

  // `42501` / `PGRST301`: the table exists but this caller may not read it —
  // i.e. an anonymous visitor. That is a permission fact, not a configuration
  // one, so the feature IS configured.
  const code = (error as { code?: string }).code;
  if (code === "42501" || code === "PGRST301") return true;

  // Any other failure is a real fault; do not hide it behind "not configured".
  throw error;
}

export async function listSupportTickets(userId: string, limit = 50): Promise<SupportTicket[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("support_tickets")
    .select("*")
    .eq("user_id", userId)
    .order("last_activity_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as SupportTicket[];
}

export async function listSupportMessages(ticketId: string): Promise<SupportMessage[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("support_messages")
    .select("*")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) throw error;
  return (data ?? []) as SupportMessage[];
}

/** Ordered tickets with their messages, for the signed-in user's support page. */
export async function listOwnTicketsWithMessages(
  userId: string,
): Promise<{ ticket: SupportTicket; messages: SupportMessage[] }[]> {
  const tickets = await listSupportTickets(userId);
  if (tickets.length === 0) return [];

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("support_messages")
    .select("*")
    .in(
      "ticket_id",
      tickets.map((ticket) => ticket.id),
    )
    .order("created_at", { ascending: true });

  if (error) throw error;

  const byTicket = new Map<string, SupportMessage[]>();
  for (const message of (data ?? []) as SupportMessage[]) {
    const list = byTicket.get(message.ticket_id) ?? [];
    list.push(message);
    byTicket.set(message.ticket_id, list);
  }

  return tickets.map((ticket) => ({ ticket, messages: byTicket.get(ticket.id) ?? [] }));
}

export async function createSupportTicket(input: {
  category: string;
  subject: string;
  message: string;
  reference?: string | null;
}): Promise<SupportTicket> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("support_create_ticket", {
    p_category: input.category,
    p_subject: input.subject,
    p_body: input.message,
    p_related_reference: input.reference ?? null,
  });

  if (error) throw error;
  return data as SupportTicket;
}

export async function replyToSupportTicket(ticketId: string, message: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("support_add_message", {
    p_ticket_id: ticketId,
    p_body: message,
  });

  if (error) throw error;
  return data as SupportMessage;
}

/* -------------------------------------------------------------------------- */
/* Administrator side                                                         */
/* -------------------------------------------------------------------------- */

/** A queue row: the ticket plus enough of the owner to judge it, and nothing more. */
export type SupportQueueRow = SupportTicket & {
  userLabel: string;
  userEmail: string | null;
  messageCount: number;
  lastMessage: string | null;
};

/**
 * The administrator queue.
 *
 * Reads with the service-role client because it spans every user's tickets;
 * RLS is not the gate here, `requireAdmin()` on the route is. Only a display
 * name and email are joined — an administrator answering a payment question
 * does not need the caller's balance in the list view.
 */
export async function listSupportQueue(options: {
  status?: SupportTicketStatus | "ALL";
  limit?: number;
} = {}): Promise<SupportQueueRow[]> {
  const admin = createAdminSupabaseClient();
  const limit = Math.min(200, Math.max(1, options.limit ?? 100));

  let query = admin
    .from("support_tickets")
    .select("*")
    .order("last_activity_at", { ascending: false })
    .limit(limit);

  if (options.status && options.status !== "ALL") {
    query = query.eq("status", options.status);
  }

  const { data, error } = await query;
  if (error) throw error;

  const tickets = (data ?? []) as SupportTicket[];
  if (tickets.length === 0) return [];

  const ids = tickets.map((ticket) => ticket.id);
  const userIds = [...new Set(tickets.map((ticket) => ticket.user_id))];

  const [profilesRes, messagesRes] = await Promise.all([
    admin.from("profiles").select("id, full_name, email").in("id", userIds),
    admin
      .from("support_messages")
      .select("ticket_id, body, author_role, created_at")
      .in("ticket_id", ids)
      .order("created_at", { ascending: true }),
  ]);

  const profiles = new Map(
    ((profilesRes.data ?? []) as { id: string; full_name: string; email: string }[]).map((p) => [
      p.id,
      p,
    ]),
  );

  const counts = new Map<string, number>();
  const latest = new Map<string, { body: string; author_role: string }>();
  for (const message of (messagesRes.data ?? []) as {
    ticket_id: string;
    body: string;
    author_role: string;
  }[]) {
    counts.set(message.ticket_id, (counts.get(message.ticket_id) ?? 0) + 1);
    latest.set(message.ticket_id, message);
  }

  return tickets.map((ticket) => {
    const profile = profiles.get(ticket.user_id);
    const last = latest.get(ticket.id);
    return {
      ...ticket,
      userLabel: profile?.full_name?.trim() || "Unnamed user",
      userEmail: profile?.email ?? null,
      messageCount: counts.get(ticket.id) ?? 0,
      lastMessage: last ? `${last.author_role === "ADMIN" ? "Us: " : "User: "}${last.body}` : null,
    };
  });
}

/** Counts per status, for the queue tabs. One query, not four. */
export async function countSupportByStatus(): Promise<Record<string, number>> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.from("support_tickets").select("status");
  if (error) throw error;

  const out: Record<string, number> = { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, CLOSED: 0 };
  for (const row of (data ?? []) as { status: string }[]) {
    out[row.status] = (out[row.status] ?? 0) + 1;
  }
  return out;
}

/** Full thread for one ticket, for the administrator detail view. */
export async function getTicketThread(
  ticketId: string,
): Promise<{ ticket: SupportTicket; messages: SupportMessage[] } | null> {
  const admin = createAdminSupabaseClient();

  const { data: ticket, error } = await admin
    .from("support_tickets")
    .select("*")
    .eq("id", ticketId)
    .maybeSingle<SupportTicket>();

  if (error) throw error;
  if (!ticket) return null;

  const { data: messages, error: messagesError } = await admin
    .from("support_messages")
    .select("*")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });

  if (messagesError) throw messagesError;
  return { ticket, messages: (messages ?? []) as SupportMessage[] };
}

/**
 * Administrator reply and/or status change.
 *
 * Runs through the request-scoped client on purpose: the SQL function derives the
 * acting administrator from auth.uid() and re-checks the role itself, so the
 * authorization is enforced in the database rather than trusted from the route.
 */
export async function adminReplyToTicket(input: {
  ticketId: string;
  body?: string | null;
  status?: SupportTicketStatus | null;
  ipHash?: string | null;
}): Promise<SupportTicket> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("support_admin_reply", {
    p_ticket_id: input.ticketId,
    p_body: input.body ?? null,
    p_status: input.status ?? null,
    p_ip_hash: input.ipHash ?? null,
  });

  if (error) throw error;
  return data as SupportTicket;
}
