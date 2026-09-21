import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { campaignUpsertSchema, videoUpsertSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { upsertCampaign, upsertVideo } from "@/server/services/admin";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

/** GET /api/admin/videos — all videos and campaigns, including drafts. */
export async function GET() {
  return runApi(async () => {
    await requireAdmin();
    const admin = createAdminSupabaseClient();

    const [videos, campaigns, currencies] = await Promise.all([
      admin.from("videos").select("*").order("created_at", { ascending: false }).limit(200),
      admin.from("video_campaigns").select("*").order("created_at", { ascending: false }).limit(200),
      admin.from("currencies").select("code, name, enabled").order("code"),
    ]);

    return ok({
      videos: videos.data ?? [],
      campaigns: campaigns.data ?? [],
      currencies: currencies.data ?? [],
    });
  });
}

/**
 * POST /api/admin/videos — create or update a video, or a campaign.
 *
 * Campaign budgets are the ceiling on rewards: once `spent` reaches `budget`,
 * public.campaign_is_payable() returns false and rewards stop automatically.
 */
export async function POST(request: Request) {
  return runApi(async () => {
    const session = await requireAdmin();
    await enforceRateLimit(
      RATE_LIMITS.adminMutation.bucket,
      session.profile.id,
      RATE_LIMITS.adminMutation.limit,
      RATE_LIMITS.adminMutation.window,
      RATE_LIMITS.adminMutation.mode,
    );

    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") ?? "video";

    if (kind === "campaign") {
      const body = await parseBody(request, campaignUpsertSchema);
      const campaign = await upsertCampaign({
        adminId: session.profile.id,
        campaignId: body.id,
        payload: body as unknown as Record<string, unknown>,
      });
      return ok({ campaign, message: "Campaign saved." });
    }

    const body = await parseBody(request, videoUpsertSchema);
    const video = await upsertVideo({
      adminId: session.profile.id,
      videoId: body.id,
      payload: body as unknown as Record<string, unknown>,
    });

    return ok({
      video,
      message:
        "Video saved. Rewards only pay out while the campaign has budget remaining and the required watch time is met.",
    });
  });
}
