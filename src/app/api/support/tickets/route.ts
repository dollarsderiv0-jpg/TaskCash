import { requireSessionUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { supportTicketSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { anonymousRateLimitIdentifier, requestContext } from "@/lib/api/context";
import { apiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import {
  createSupportTicket,
  isSupportConfigured,
  listOwnTicketsWithMessages,
} from "@/server/services/support";
import { notifyUser } from "@/server/services/notifications";

/**
 * POST /api/support/tickets — open a support request.
 * GET  /api/support/tickets — the caller's own requests with their replies.
 *
 * Deliberately NOT gated behind email verification: a user whose confirmation
 * email never arrived is exactly the person most likely to need support, and
 * locking them out of the help desk would strand them. Identity still comes
 * from the session, and the ticket function derives the owner from auth.uid().
 *
 * Rate limited per account and per IP, because an open help desk is a target
 * for flooding.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const session = await requireSessionUser();
    const ctx = requestContext(request);
    const input = await parseBody(request, supportTicketSchema);

    // Report the honest reason rather than a generic failure: the schema this
    // feature needs is applied by migration 0006.
    if (!(await isSupportConfigured())) {
      throw apiError(
        "SUPPORT_NOT_CONFIGURED",
        "Support requests are being set up right now. Please reach us through the contact details on this page.",
        503,
      );
    }

    await enforceRateLimit(
      RATE_LIMITS.supportTicket.bucket,
      session.profile.id,
      RATE_LIMITS.supportTicket.limit,
      RATE_LIMITS.supportTicket.window,
      RATE_LIMITS.supportTicket.mode,
    );
    await enforceRateLimit(
      `${RATE_LIMITS.supportTicket.bucket}:ip`,
      anonymousRateLimitIdentifier(ctx),
      RATE_LIMITS.supportTicket.limit * 2,
      RATE_LIMITS.supportTicket.window,
      RATE_LIMITS.supportTicket.mode,
    );

    const ticket = await createSupportTicket({
      category: input.category,
      subject: input.subject,
      message: input.message,
      reference: input.reference ?? null,
    });

    logger.info("support_ticket_created", {
      ticketReference: ticket.reference,
      category: ticket.category,
    });

    // Best-effort acknowledgement in the user's notification list. A failure
    // here must not lose a ticket that was already saved.
    try {
      await notifyUser({
        userId: session.profile.id,
        type: "SUPPORT_TICKET_CREATED",
        title: "We received your request",
        message: `Your support request ${ticket.reference} is with our team. We will reply in your support page.`,
        severity: "INFO",
        link: "/support",
        metadata: { ticketId: ticket.id, reference: ticket.reference },
      });
    } catch (error) {
      logger.warn("support_notification_failed", { error: String(error) });
    }

    return ok({
      ticket,
      message: `Thanks — your request was received with reference ${ticket.reference}.`,
    });
  });
}

export async function GET() {
  return runApi(async () => {
    const session = await requireSessionUser();

    if (!(await isSupportConfigured())) {
      return ok({ tickets: [], configured: false });
    }

    const tickets = await listOwnTicketsWithMessages(session.profile.id);
    return ok({ tickets, configured: true });
  });
}
