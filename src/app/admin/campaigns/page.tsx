import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/guards";

/**
 * `/admin/campaigns` → `/admin/videos`.
 *
 * Campaigns are not a separate screen: a campaign owns the budget and the video
 * owns the reward, and one editor manages both together, because editing either
 * in isolation is how you end up with a funded campaign nobody can watch or a
 * video pointing at an exhausted budget. Duplicating that editor behind a second
 * route would create two places to change the same money.
 *
 * This exists so the documented URL resolves. The admin guard runs first, so an
 * unauthenticated or non-admin visitor is redirected to the dashboard by the
 * guard rather than by `redirect()` — the ordering matters and is why
 * `requireAdmin()` is called before `redirect()`.
 */
export default async function AdminCampaignsPage() {
  await requireAdmin();
  redirect("/admin/videos");
}
