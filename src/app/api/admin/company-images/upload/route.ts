import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { apiError } from "@/lib/api/errors";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  COMPANY_IMAGE_MAX_BYTES,
  CompanyImageUploadError,
  uploadCompanyImageObject,
} from "@/server/services/company-images";

/**
 * POST /api/admin/company-images/upload — put a picture in the company-images
 * bucket and return its public address.
 *
 * A separate route from the CRUD endpoint on purpose: this request is multipart
 * form data, so it cannot go through `parseBody`'s JSON schema path, and keeping
 * it separate means the JSON API stays uniformly JSON.
 *
 * The bytes are validated here and nowhere else is that possible: the extension
 * is derived from the declared content type, never from the operator's file name,
 * and the object path is generated rather than trusted.
 *
 * Nothing is written to the database by this route. The caller receives the
 * address and the bucket path, and saves them with a separate save — so an
 * upload the operator abandons leaves no row behind.
 */

/** 2 MB, matching what the service enforces. */
const MAX_BYTES = COMPANY_IMAGE_MAX_BYTES;

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

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw apiError("VALIDATION_ERROR", "Send the picture as multipart form data.", 400);
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      throw apiError("VALIDATION_ERROR", "Choose a picture to upload.", 400);
    }

    if (file.size === 0) {
      throw apiError("VALIDATION_ERROR", "That file is empty.", 400);
    }

    if (file.size > MAX_BYTES) {
      throw apiError(
        "VALIDATION_ERROR",
        `Pictures must be smaller than ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`,
        413,
      );
    }

    try {
      const uploaded = await uploadCompanyImageObject({
        contentType: file.type,
        bytes: await file.arrayBuffer(),
      });

      return ok({ imageUrl: uploaded.url, storagePath: uploaded.path });
    } catch (error) {
      // An unsupported type, an oversized body or a missing bucket is the
      // operator's problem to fix, so it is reported as a 400 with the sentence
      // that explains it — not as a 500 that reads like an outage.
      if (error instanceof CompanyImageUploadError) {
        throw apiError("UPLOAD_REFUSED", error.message, 400);
      }
      throw error;
    }
  });
}
