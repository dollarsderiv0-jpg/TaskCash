import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { parseBody } from "@/lib/validation/parse";
import { companyImageDeleteSchema, companyImageUpsertSchema } from "@/lib/validation/schemas";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  deleteCompanyImage,
  listAllCompanyImages,
  upsertCompanyImage,
} from "@/server/services/company-images";

/**
 * /api/admin/company-images — manage the pictures of the companies behind the
 * platform, shown on the landing page and the signed-in dashboard.
 *
 * Display only: nothing here credits a wallet, so this route never touches the
 * ledger and a mistake in it cannot move money. Uploading the file itself is a
 * separate endpoint (./upload) because that request is multipart, not JSON.
 */

/** GET /api/admin/company-images — every picture, including hidden ones. */
export async function GET() {
  return runApi(async () => {
    await requireAdmin();
    const { images, available } = await listAllCompanyImages();
    return ok({ companyImages: images, available });
  });
}

/** POST /api/admin/company-images — create or update one picture's details. */
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

    const body = await parseBody(request, companyImageUpsertSchema);
    const image = await upsertCompanyImage({
      adminId: session.profile.id,
      imageId: body.id,
      payload: body as unknown as Record<string, unknown>,
    });

    return ok({
      companyImage: image,
      message: body.id ? "Company image saved." : "Company image added.",
    });
  });
}

/**
 * DELETE /api/admin/company-images — remove a picture.
 *
 * Also removes the uploaded object from storage when this app put it there; an
 * externally hosted picture is left alone, because the file was never ours.
 */
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

    const body = await parseBody(request, companyImageDeleteSchema);
    await deleteCompanyImage({ adminId: session.profile.id, imageId: body.id });

    return ok({ message: "Company image removed." });
  });
}
