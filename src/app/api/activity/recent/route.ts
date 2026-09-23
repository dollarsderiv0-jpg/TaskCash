import { requireSessionUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { listRecentActivity } from "@/server/services/activity";

/**
 * GET /api/activity/recent — the masked recent-activity feed.
 *
 * Signed-in callers only. The feed describes OTHER people's movements, so it is
 * gated on a session for two reasons at once: there is no reason to hand a
 * rotating record of customer activity to the open internet, and the viewer's
 * own profile id is what the service excludes rows by.
 *
 * The response is the already-masked shape — no amount, no id, no contact
 * detail — so this route has nothing to redact. It reads nothing from the
 * request, which is why it takes no parameters and cannot be steered.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return runApi(async () => {
    const session = await requireSessionUser();
    const { items, available } = await listRecentActivity({
      viewerProfileId: session.profile.id,
    });

    return ok({ items, available });
  });
}
