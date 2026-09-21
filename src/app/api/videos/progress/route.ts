import { requireSessionUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { videoProgressSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { reportVideoProgress } from "@/server/services/videos";

/**
 * POST /api/videos/progress
 *
 * The reported value is a hint only. The database clamps it to the wall-clock
 * time that has actually elapsed since the server started the session, so
 * reporting "watched 60 seconds" one second in has no effect.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const session = await requireSessionUser();

    await enforceRateLimit(
      RATE_LIMITS.videoProgress.bucket,
      session.profile.id,
      RATE_LIMITS.videoProgress.limit,
      RATE_LIMITS.videoProgress.window,
      RATE_LIMITS.videoProgress.mode,
    );

    const input = await parseBody(request, videoProgressSchema);

    const progress = await reportVideoProgress({
      userId: session.profile.id,
      sessionToken: input.sessionToken,
      watchedSeconds: input.watchedSeconds,
    });

    return ok(progress);
  });
}
