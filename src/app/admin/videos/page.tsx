import { requireAdmin } from "@/lib/auth/guards";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { VideosEditor } from "@/components/admin/videos-editor";
import type { Video, VideoCampaign } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AdminVideosPage() {
  await requireAdmin();

  const admin = createAdminSupabaseClient();
  const [videosRes, campaignsRes, currenciesRes] = await Promise.all([
    admin.from("videos").select("*").order("created_at", { ascending: false }).limit(200),
    admin.from("video_campaigns").select("*").order("created_at", { ascending: false }).limit(200),
    admin.from("currencies").select("code, name, enabled").order("code"),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Videos &amp; campaigns</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure campaigns, rewards, required watch time and limits.
        </p>
      </div>

      <VideosEditor
        videos={(videosRes.data ?? []) as Video[]}
        campaigns={(campaignsRes.data ?? []) as VideoCampaign[]}
        currencies={
          (currenciesRes.data ?? []) as { code: string; name: string; enabled: boolean }[]
        }
      />
    </div>
  );
}
