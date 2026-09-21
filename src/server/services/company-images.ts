import { randomUUID } from "node:crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { BUNDLED_COMPANY_IMAGES } from "@/content/company-images";
import type { CompanyImage } from "@/lib/types";

/**
 * Company images — the pictures of the companies behind the platform
 * (migration 0016).
 *
 * Read paths use the CALLER-SCOPED client, so "only visible rows" is applied by
 * the database's own policy rather than by a filter repeated here. Admin paths
 * use the service role and are called only from routes that have already passed
 * requireAdmin(), which is why they live in this file next to the read they
 * mirror — the same arrangement advertisements and support tickets use.
 *
 * Nothing here moves money. A company picture is display only, so there is no
 * ledger entry, no reward and no session to verify.
 *
 * The image BYTES live in Supabase Storage, not in this database (see 0016 for
 * why). `image_url` is the address a browser loads directly; nothing here proxies
 * or streams an image, and the only upload this file performs is the admin's own.
 */

export type CompanyImagesResult = {
  images: CompanyImage[];
  /**
   * False when migration 0016 has not been applied to this database. Reported
   * rather than thrown so the page can say "this section is being set up" instead
   * of a 500 — and so an absent table never renders as an innocent empty gallery,
   * which would look like "no pictures exist" when the truth is "the table is
   * missing".
   */
  available: boolean;
};

const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205", "PGRST204"]);
const MISSING_TABLE_TEXT = /could not find the table|does not exist/i;

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code && MISSING_TABLE_CODES.has(error.code)) return true;
  return MISSING_TABLE_TEXT.test(error.message ?? "");
}

/* -------------------------------------------------------------------------- */
/* storage                                                                    */
/* -------------------------------------------------------------------------- */

/** The bucket migration 0016 creates. */
export const COMPANY_IMAGE_BUCKET = "company-images";

/** 2 MB. A logo on a landing page has no business being larger. */
export const COMPANY_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Accepted upload types, mapped to the extension used in the object path.
 *
 * SVG is deliberately NOT accepted. It is the one image format that can carry
 * script, and it would be served from the storage origin with a content type the
 * browser renders as a document when opened directly. A PNG has no such ability,
 * and the operator can flatten an SVG before uploading it.
 */
export const COMPANY_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Raised when an upload is refused for a reason the operator can act on. */
export class CompanyImageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyImageUploadError";
  }
}

/**
 * Put bytes in the bucket and return the public address.
 *
 * Runs with the service role, which bypasses storage RLS, so this must never be
 * called from a route that has not already authorised an administrator.
 */
export async function uploadCompanyImageObject(input: {
  contentType: string;
  bytes: ArrayBuffer;
}): Promise<{ path: string; url: string }> {
  const admin = createAdminSupabaseClient();

  const extension = COMPANY_IMAGE_TYPES[input.contentType];
  if (!extension) {
    throw new CompanyImageUploadError(
      "Upload a PNG, JPEG or WebP picture. SVG is not accepted because it can carry script.",
    );
  }

  /*
    A UUID path, not the operator's file name. A file name arrives from the
    browser and may contain anything — including `../`, which is exactly how an
    upload escapes its prefix in object stores that resolve paths literally. The
    name the operator typed is stored in the `name` column; the object does not
    need it.
  */
  const path = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${extension}`;

  const { error } = await admin.storage.from(COMPANY_IMAGE_BUCKET).upload(path, input.bytes, {
    contentType: input.contentType,
    // Never overwrite: the path is unique anyway, and an upsert would let a
    // colliding name replace somebody else's picture.
    upsert: false,
    cacheControl: "31536000",
  });

  if (error) {
    // The bucket is created by migration 0016. Say so plainly rather than
    // surfacing a raw storage error that reads like the upload was malformed.
    if (/bucket not found/i.test(error.message)) {
      throw new CompanyImageUploadError(
        "The image storage bucket does not exist yet — migration 0016 has not been applied to this database.",
      );
    }
    throw new CompanyImageUploadError(error.message);
  }

  const { data } = admin.storage.from(COMPANY_IMAGE_BUCKET).getPublicUrl(path);
  return { path, url: data.publicUrl };
}

/**
 * Best-effort removal of an uploaded object.
 *
 * Used after the row is gone, so a failure here leaves an orphaned file rather
 * than a broken reference — which is the harmless direction to fail in. It never
 * throws: the operator deleted a row and that deletion succeeded.
 */
async function removeStoredObject(path: string) {
  try {
    const admin = createAdminSupabaseClient();
    await admin.storage.from(COMPANY_IMAGE_BUCKET).remove([path]);
  } catch {
    // Intentionally swallowed — see the doc comment.
  }
}

/* -------------------------------------------------------------------------- */
/* reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the PUBLIC section is allowed to read.
 *
 * Deliberately not the full `CompanyImage`: migration 0016 grants `anon` the
 * columns the section renders and withholds `created_by` (the uploading
 * administrator's profile id) and `storage_path` (an internal bucket path).
 * Typing the narrow shape makes that a compile-time fact rather than a comment.
 */
export type PublicCompanyImage = Omit<CompanyImage, "created_by" | "storage_path" | "updated_at">;

const PUBLIC_COLUMNS =
  "id, name, caption, image_url, link_url, sort_order, status, created_at";

/**
 * Visible pictures for the public site — the landing page, read by people who
 * have not signed in.
 *
 * Runs on the caller-scoped client, so the anonymous visitor is subject to RLS
 * exactly like anyone else and "HIDDEN means gone" stays in the database.
 *
 * A missing table (0016 not yet applied) is reported as `available: false`. The
 * landing page must never 500 because a migration is pending: it is the first
 * page a stranger sees.
 */
export async function listPublicCompanyImages(limit = 24): Promise<{
  images: PublicCompanyImage[];
  available: boolean;
}> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("company_images")
    .select(PUBLIC_COLUMNS)
    .eq("status", "ACTIVE")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingTable(error)) return { images: [], available: false };
    throw error;
  }

  return { images: (data ?? []) as unknown as PublicCompanyImage[], available: true };
}

/**
 * What the public section and the dashboard slideshow render.
 *
 * Database rows when there are any, otherwise the pictures bundled with the app.
 * The rule is deliberately that simple, and it exists because migration 0016 is
 * not applied to the production database yet: the section has to work today, not
 * after somebody pastes SQL.
 *
 * It also means the fallback retires itself. The first picture an operator adds
 * in /admin/company-images makes the table non-empty, and from then on the
 * database is the only source — including for the bundled four, which then
 * become editable rows rather than hardcoded content.
 */
export async function listShowcaseCompanyImages(limit = 24): Promise<PublicCompanyImage[]> {
  const { images } = await listPublicCompanyImages(limit);
  return images.length > 0 ? images : BUNDLED_COMPANY_IMAGES;
}

/** Every picture, including hidden ones. Admin screens only. */
export async function listAllCompanyImages(): Promise<CompanyImagesResult> {
  const admin = createAdminSupabaseClient();

  const { data, error } = await admin
    .from("company_images")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    if (isMissingTable(error)) return { images: [], available: false };
    throw error;
  }

  return { images: (data ?? []) as CompanyImage[], available: true };
}

/* -------------------------------------------------------------------------- */
/* admin mutations — service role, audit-logged                               */
/* -------------------------------------------------------------------------- */

export async function upsertCompanyImage(input: {
  adminId: string;
  payload: Record<string, unknown>;
  imageId?: string;
}) {
  const admin = createAdminSupabaseClient();

  const record = {
    name: input.payload.name,
    caption: input.payload.caption ?? null,
    image_url: input.payload.imageUrl,
    storage_path: input.payload.storagePath ?? null,
    link_url: input.payload.linkUrl ?? null,
    sort_order: input.payload.sortOrder,
    status: input.payload.status,
    // Only stamped on create: an edit should not reassign authorship.
    ...(input.imageId ? {} : { created_by: input.adminId }),
  };

  const query = input.imageId
    ? admin
        .from("company_images")
        .update(record)
        .eq("id", input.imageId)
        .select("id, name, status")
        .single()
    : admin.from("company_images").insert(record).select("id, name, status").single();

  const { data, error } = await query;
  if (error) throw error;

  await admin.rpc("write_audit", {
    p_admin_id: input.adminId,
    p_user_id: null,
    p_action: input.imageId ? "COMPANY_IMAGE_UPDATED" : "COMPANY_IMAGE_CREATED",
    p_entity: "company_image",
    p_entity_id: data.id,
    p_description: `${input.imageId ? "Updated" : "Added"} company image "${data.name}"`,
    p_metadata: { status: data.status },
    p_ip_hash: null,
    p_user_agent: null,
  });

  return data;
}

/* -------------------------------------------------------------------------- */
/* bulk import                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The most pictures one bulk import will accept.
 *
 * A cap rather than no cap: the whole batch travels in ONE multipart request, and
 * a request is a single unit of memory on the server. Twenty logos is more than a
 * sponsored-by strip will ever show, so the limit costs the operator nothing and
 * keeps an accidental 400-file selection from becoming an outage.
 */
export const COMPANY_IMAGE_BULK_MAX_FILES = 20;

/**
 * A company name derived from the file name the operator chose.
 *
 * `netflix-logo.png` becomes `netflix logo`. The name is what the slideshow's
 * caption falls back to and what the admin list shows, so deriving it means a
 * batch of ten logos lands already named instead of ten rows called "Company
 * logo 1".
 *
 * The extension is dropped, separators become spaces, and control characters and
 * angle brackets are removed — the name is rendered in HTML and in an audit row,
 * and there is no reason for either to carry them. The result is length-checked
 * against the column's own constraint, with a generated fallback, so a file named
 * `a.png` cannot fail the insert for being too short.
 */
function companyNameFromFileName(fileName: string, index: number): string {
  const cleaned = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/[\u0000-\u001f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length >= 2) return cleaned.slice(0, 120);
  return `Company logo ${index + 1}`;
}

export type CompanyImageImportItem = {
  /** Used only to derive a name and to report a failure against. Never a path. */
  fileName: string;
  contentType: string;
  bytes: ArrayBuffer;
};

export type CompanyImageImportResult = {
  created: { id: string; name: string; imageUrl: string }[];
  /** Partially successful batches are the normal case: one oversized logo must
   *  not throw away the other nine. */
  failed: { fileName: string; reason: string }[];
};

/**
 * Import several pictures in one submission.
 *
 * Each file becomes its own row, ACTIVE and immediately part of the slideshow,
 * with the sort order continuing from `startSortOrder` so a batch keeps the order
 * the operator selected. The caption, when given, applies to the whole batch —
 * "Sponsor" for a row of sponsor logos is one decision, not ten.
 *
 * A file that fails is reported and skipped, and any object already uploaded for
 * a row that then failed to insert is removed again, so a failed import does not
 * leave files in the bucket that nothing points at.
 */
export async function importCompanyImageFiles(input: {
  adminId: string;
  items: CompanyImageImportItem[];
  caption: string | null;
  startSortOrder: number;
}): Promise<CompanyImageImportResult> {
  const result: CompanyImageImportResult = { created: [], failed: [] };

  for (const [index, item] of input.items.entries()) {
    let uploaded: { path: string; url: string } | null = null;

    try {
      uploaded = await uploadCompanyImageObject({
        contentType: item.contentType,
        bytes: item.bytes,
      });

      const row = await upsertCompanyImage({
        adminId: input.adminId,
        payload: {
          name: companyNameFromFileName(item.fileName, index),
          caption: input.caption,
          imageUrl: uploaded.url,
          storagePath: uploaded.path,
          // A batch has no per-file link, and inventing one from the file name
          // would be worse than none: a logo that links somewhere unintended is
          // a trap for the visitor, not a feature.
          linkUrl: null,
          sortOrder: input.startSortOrder + index,
          status: "ACTIVE",
        },
      });

      result.created.push({
        id: String(row.id),
        name: String(row.name),
        imageUrl: uploaded.url,
      });
    } catch (error) {
      if (uploaded) await removeStoredObject(uploaded.path);
      result.failed.push({
        fileName: item.fileName,
        reason:
          error instanceof CompanyImageUploadError
            ? error.message
            : "The picture was uploaded but could not be listed. It has been removed again.",
      });
    }
  }

  return result;
}

/**
 * Remove a picture, and the stored object with it.
 *
 * A hard delete, like an advertisement: a company picture carries no financial
 * history that has to survive it, unlike a withdrawal, where deleting the row
 * would erase the record of a decision. "HIDDEN" exists for taking a picture off
 * the site while keeping the row.
 */
export async function deleteCompanyImage(input: { adminId: string; imageId: string }) {
  const admin = createAdminSupabaseClient();

  const { data, error } = await admin
    .from("company_images")
    .delete()
    .eq("id", input.imageId)
    .select("id, name, storage_path")
    .single();

  if (error) throw error;

  // Only for a file this app uploaded. A pasted external URL has no
  // `storage_path`, and removing it from our bucket would be meaningless.
  if (data.storage_path) await removeStoredObject(data.storage_path);

  await admin.rpc("write_audit", {
    p_admin_id: input.adminId,
    p_user_id: null,
    p_action: "COMPANY_IMAGE_DELETED",
    p_entity: "company_image",
    p_entity_id: data.id,
    p_description: `Deleted company image "${data.name}"`,
    p_metadata: { removedStoredObject: Boolean(data.storage_path) },
    p_ip_hash: null,
    p_user_agent: null,
  });

  return data;
}
