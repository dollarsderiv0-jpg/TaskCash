import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { advertisementDeleteSchema, advertisementUpsertSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  deleteAdvertisement,
  listAllAdvertisements,
  upsertAdvertisement,
} from "@/server/services/advertisements";

/**
 * /api/admin/ads — manage the sponsored gallery.
 *
 * Advertisements are DISPLAY ONLY: nothing here credits a wallet, so this route
 * never touches the ledger and a mistake in it cannot move money.
 */

/** GET /api/admin/ads — every advert, including drafts and archived ones. */
export async function GET() {
  return runApi(async () => {
    await requireAdmin();
    const { ads, available } = await listAllAdvertisements();
    return ok({ advertisements: ads, available });
  });
}

/** POST /api/admin/ads — create or update an advert. */
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

    const body = await parseBody(request, advertisementUpsertSchema);
    const advertisement = await upsertAdvertisement({
      adminId: session.profile.id,
      advertisementId: body.id,
      payload: body as unknown as Record<string, unknown>,
    });

    return ok({
      advertisement,
      message: body.id ? "Advertisement saved." : "Advertisement created.",
    });
  });
}

/** DELETE /api/admin/ads — remove an advert outright. */
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

    const body = await parseBody(request, advertisementDeleteSchema);
    await deleteAdvertisement({ adminId: session.profile.id, advertisementId: body.id });

    return ok({ message: "Advertisement removed." });
  });
}
