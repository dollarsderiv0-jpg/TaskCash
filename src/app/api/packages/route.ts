import { requireVerifiedUser } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { listPackageCatalogue } from "@/server/services/packages";

/**
 * GET /api/packages — the published tiers, annotated for the signed-in user.
 *
 * Read-only. Prices and caps come from the database; the only user-specific
 * figures are how much of today's allowance is left and when it resets, both
 * computed by `package_daily_usage` so the number shown is the number enforced.
 */
export async function GET() {
  return runApi(async () => {
    const session = await requireVerifiedUser("packages.list");
    const catalogue = await listPackageCatalogue(session.profile.id);
    return ok(catalogue);
  });
}
