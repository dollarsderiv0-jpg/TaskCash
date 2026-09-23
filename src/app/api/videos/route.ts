import { requireSessionUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { listAvailableVideos } from "@/server/services/videos";

/**
 * GET /api/videos — one page of active campaigns the user can currently watch.
 *
 * Paged because the payload is the product: the catalogue used to be returned
 * whole, which for 305 videos meant ~209KB of JSON for every request. `limit` is
 * clamped inside the service, so a hand-written `?limit=100000` cannot undo that.
 *
 * The rows are the service's own cards, unchanged. They are NOT reshaped here:
 * this endpoint's field names (`reward_amount`, `video_url`, `campaign`, …) are
 * relied on by the Earn check and by anything else driving the platform's own
 * API, so paging is the only change — a rename would silently break callers while
 * still looking like a successful response.
 */
export async function GET(request: Request) {
  return runApi(async () => {
    const session = await requireSessionUser();
    const params = new URL(request.url).searchParams;

    const page = await listAvailableVideos(session.profile.id, {
      offset: Number(params.get("offset") ?? 0),
      limit: params.get("limit") === null ? undefined : Number(params.get("limit")),
      /*
        Narrows the page to one tier's videos, which is what Watch & Earn shows
        once a package is chosen. Safe to accept from a request: it only ever
        shrinks the result, and every eligibility rule — including whether the
        caller holds that tier — is still decided by the service.
      */
      packageId: params.get("packageId"),
    });

    return ok({
      videos: page.items,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
    });
  });
}
