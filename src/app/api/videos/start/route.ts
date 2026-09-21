import { requireVerifiedUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { videoStartSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { requestContext } from "@/lib/api/context";
import { startVideoSession } from "@/server/services/videos";

/**
 * POST /api/videos/start
 *
 * Creates (or resumes) a server-tracked watch session. Eligibility, campaign
 * budget, daily limits, cooldown and velocity are all enforced inside the
 * database function — the client cannot skip any of them.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const session = await requireVerifiedUser("videos.start");
    const ctx = requestContext(request);

    await enforceRateLimit(
      RATE_LIMITS.videoStart.bucket,
      session.profile.id,
      RATE_LIMITS.videoStart.limit,
      RATE_LIMITS.videoStart.window,
      RATE_LIMITS.videoStart.mode,
    );

    const input = await parseBody(request, videoStartSchema);

    const watch = await startVideoSession({
      userId: session.profile.id,
      videoId: input.videoId,
      ipHash: ctx.ipHash,
      deviceHash: ctx.deviceHash,
    });

    return ok(watch);
  });
}
