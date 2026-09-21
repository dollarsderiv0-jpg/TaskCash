import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { packageDeleteSchema, packageUpsertSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  deletePackage,
  listAllPackages,
  listPackageVideoIds,
  upsertPackage,
} from "@/server/services/packages";

/**
 * /api/admin/packages — manage the paid tiers.
 *
 * Requires an administrator on every verb. Note what this route does NOT accept:
 * a price, a cap or a video list for an EXISTING user's purchase. Changing a
 * tier updates the tier; the users who already bought it keep the snapshot they
 * paid for, which is enforced in the database rather than trusted here.
 */

/** GET /api/admin/packages — every tier, including drafts, with its videos. */
export async function GET() {
  return runApi(async () => {
    await requireAdmin();
    const [{ packages, available }, videoIds] = await Promise.all([
      listAllPackages(),
      listPackageVideoIds(),
    ]);
    return ok({ packages, available, videoIds });
  });
}

/** POST /api/admin/packages — create or update a tier. */
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

    const body = await parseBody(request, packageUpsertSchema);
    const tier = await upsertPackage({
      adminId: session.profile.id,
      packageId: body.id,
      payload: body as unknown as Record<string, unknown>,
    });

    return ok({
      package: tier,
      message: body.id ? "Package saved." : "Package created.",
    });
  });
}

/** DELETE /api/admin/packages — remove a tier nobody holds. */
export async function DELETE(request: Request) {
  return runApi(async () => {
    const session = await requireAdmin();
    await enforceRateLimit(
      RATE_LIMITS.adminMutation.bucket,
      session.profile.id,
      RATE_LIMITS.adminMutation.limit,
      RATE_LIMITS.adminMutation.window,
      RATE_LIMITS.adminMutation.mode,
    );

    const body = await parseBody(request, packageDeleteSchema);
    await deletePackage({ adminId: session.profile.id, packageId: body.id });

    return ok({ message: "Package removed." });
  });
}
