import { requireAdmin } from "@/lib/auth/guards";
import { ok, runApi } from "@/lib/api/response";
import { apiError } from "@/lib/api/errors";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  COMPANY_IMAGE_BULK_MAX_FILES,
  COMPANY_IMAGE_MAX_BYTES,
  COMPANY_IMAGE_TYPES,
  importCompanyImageFiles,
} from "@/server/services/company-images";

/**
 * POST /api/admin/company-images/bulk — add several company pictures in ONE
 * submission, each becoming a row that is immediately part of the slideshow.
 *
 * This exists because the single-picture route makes a sponsored-by strip ten
 * round trips of "choose file, upload, save": the operator uploads the logos
 * once, names come from the file names, and the pictures are live together.
 *
 * Multipart, like ./upload, and for the same reason — a JSON schema path cannot
 * carry bytes. What is deliberately NOT accepted from the request: the sort order
 * of each picture (derived from the selection order), the status (always ACTIVE),
 * and the name (derived from the file name). A batch is a batch.
 *
 * One file failing does not fail the batch. The operator gets back what was added
 * and what was not, with the reason, so a single oversized logo does not mean
 * choosing all ten again.
 */

const MAX_BYTES = COMPANY_IMAGE_MAX_BYTES;

const MB = 1024 * 1024;

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
      throw apiError("VALIDATION_ERROR", "Send the pictures as multipart form data.", 400);
    }

    const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
    if (files.length === 0) {
      throw apiError("VALIDATION_ERROR", "Choose at least one picture to upload.", 400);
    }
    if (files.length > COMPANY_IMAGE_BULK_MAX_FILES) {
      throw apiError(
        "VALIDATION_ERROR",
        `Add up to ${COMPANY_IMAGE_BULK_MAX_FILES} pictures at a time.`,
        400,
      );
    }

    const rawCaption = form.get("caption");
    const caption =
      typeof rawCaption === "string" && rawCaption.trim().length > 0
        ? rawCaption.trim().slice(0, 300)
        : null;

    const rawSortOrder = form.get("startSortOrder");
    const startSortOrder = Number.isFinite(Number(rawSortOrder))
      ? Math.max(0, Math.floor(Number(rawSortOrder)))
      : 100;

    /*
      Type and size are judged HERE, before any bytes reach storage, so a batch of
      ten does not upload eight good files and then discover the ninth is a PDF.
      Anything refused is reported in the same shape as a service failure, so the
      UI has one list of problems to display rather than two.
    */
    const refused: { fileName: string; reason: string }[] = [];
    const accepted: { fileName: string; contentType: string; bytes: ArrayBuffer }[] = [];

    for (const file of files) {
      const name = file.name || "picture";
      const extension = COMPANY_IMAGE_TYPES[file.type];

      if (!extension) {
        refused.push({
          fileName: name,
          reason: "PNG, JPEG or WebP only. SVG is not accepted because it can carry script.",
        });
        continue;
      }
      if (file.size === 0) {
        refused.push({ fileName: name, reason: "That file is empty." });
        continue;
      }
      if (file.size > MAX_BYTES) {
        refused.push({
          fileName: name,
          reason: `Pictures must be smaller than ${Math.round(MAX_BYTES / MB)} MB.`,
        });
        continue;
      }

      accepted.push({
        fileName: name,
        contentType: file.type,
        bytes: await file.arrayBuffer(),
      });
    }

    const imported = await importCompanyImageFiles({
      adminId: session.profile.id,
      items: accepted,
      caption,
      startSortOrder,
    });

    const failed = [...refused, ...imported.failed];

    return ok({
      created: imported.created,
      failed,
      added: imported.created.length,
      rejected: failed.length,
      message:
        imported.created.length === 0
          ? "No pictures were added."
          : `${imported.created.length} picture${imported.created.length === 1 ? "" : "s"} added to the slideshow.` +
            (failed.length > 0 ? ` ${failed.length} could not be added.` : ""),
    });
  });
}
