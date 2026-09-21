import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { settingsUpdateSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { requestContext } from "@/lib/api/context";
import { updateSettings } from "@/server/services/admin";
import { listSettings } from "@/lib/settings";

/** GET /api/admin/settings — all configurable business rules. */
export async function GET() {
  return runApi(async () => {
    await requireAdmin();
    return ok({ settings: await listSettings() });
  });
}

/**
 * PATCH /api/admin/settings
 *
 * Money-affecting rules are also re-read inside the Postgres money functions,
 * so a change here takes effect atomically for the next financial operation.
 */
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

    const body = await parseBody(request, settingsUpdateSchema);

    await updateSettings({
      adminId: session.profile.id,
      updates: body.updates,
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    });

    return ok({ message: "Settings updated." });
  });
}
