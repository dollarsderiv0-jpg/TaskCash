import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody, parseInput } from "@/lib/validation/parse";
import { idSchema, supportAdminReplySchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { requestContext } from "@/lib/api/context";
import { adminReplyToTicket, getTicketThread, isSupportConfigured } from "@/server/services/support";
import { apiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

/**
 * GET  /api/admin/support/:id — the full thread.
 * POST /api/admin/support/:id — reply and/or move the status.
 *
 * Authorization happens twice and that is deliberate: `requireAdmin()` here, and
 * again inside `support_admin_reply()` where the acting administrator is derived
 * from auth.uid(). A route-level check alone would be trusted; a database check
 * alone would let a mis-wired route reach the function at all. Both costs are
 * trivial and one of them is the real gate.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  return runApi(async () => {
    await requireAdmin();
    const { id } = await ctx.params;
    const thread = await getTicketThread(parseInput(idSchema, id));

    if (!thread) {
      throw apiError("TICKET_NOT_FOUND", "That support request could not be found.", 404);
    }

    return ok(thread);
  });
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return runApi(async () => {
    const session = await requireAdmin();
    const reqCtx = requestContext(request);

    if (!(await isSupportConfigured())) {
      throw apiError(
        "SUPPORT_NOT_CONFIGURED",
        "Support requests are not available on this deployment yet.",
        503,
      );
    }

    await enforceRateLimit(
      RATE_LIMITS.adminMutation.bucket,
      session.profile.id,
      RATE_LIMITS.adminMutation.limit,
      RATE_LIMITS.adminMutation.window,
      RATE_LIMITS.adminMutation.mode,
    );

    const { id } = await ctx.params;
    const ticketId = parseInput(idSchema, id);
    const body = await parseBody(request, supportAdminReplySchema);

    const ticket = await adminReplyToTicket({
      ticketId,
      body: body.message ?? null,
      status: body.status ?? null,
      ipHash: reqCtx.ipHash ?? null,
    });

    logger.info("support_admin_reply", {
      ticketReference: ticket.reference,
      status: ticket.status,
      replied: Boolean(body.message),
    });

    return ok({
      ticket,
      message: body.message
        ? `Reply sent on ${ticket.reference}.`
        : `Status updated on ${ticket.reference}.`,
    });
  });
}
