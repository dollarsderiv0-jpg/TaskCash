import { z } from "zod";
import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody, parseQuery } from "@/lib/validation/parse";
import { fraudReviewSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { requestContext } from "@/lib/api/context";
import { listAdminFraudEvents, reviewFraudEvent } from "@/server/services/admin";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.string().max(40).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});

/** GET /api/admin/fraud — the review queue. Signals never auto-ban anyone. */
export async function GET(request: Request) {
  return runApi(async () => {
    await requireAdmin();
    return ok(await listAdminFraudEvents(parseQuery(request.url, querySchema)));
  });
}

/** PATCH /api/admin/fraud — review an event and optionally set risk status. */
export async function PATCH(request: Request) {
  return runApi(async () => {
    const session = await requireAdmin();
    const ctx = requestContext(request);

    await enforceRateLimit(
      RATE_LIMITS.adminMutation.bucket,
      session.profile.id,
      RATE_LIMITS.adminMutation.limit,
      RATE_LIMITS.adminMutation.window,
      RATE_LIMITS.adminMutation.mode,
    );

    const body = await parseBody(request, fraudReviewSchema);

    await reviewFraudEvent({
      adminId: session.profile.id,
      eventId: body.eventId,
      status: body.status,
      note: body.note,
      riskStatus: body.riskStatus,
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    });

    return ok({ message: "Fraud event updated." });
  });
}
