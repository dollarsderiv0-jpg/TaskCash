import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { Advertisement } from "@/lib/types";

/**
 * Advertisements — the display-only sponsored gallery (migration 0009).
 *
 * Read paths use the CALLER-SCOPED client, so the "ACTIVE and inside its
 * schedule window" rule is applied by the database's own policy rather than by
 * a filter repeated here. Admin paths use the service role and are called only
 * from routes that have already passed requireAdmin(), which is why they live
 * in this file next to the read they mirror — the same reason support tickets
 * have their own service.
 *
 * Nothing here moves money. Viewing an advertisement pays nobody, so there is no
 * balance to touch and no session to verify; the reward system is the video
 * campaign pipeline and this deliberately does not duplicate it.
 */

/**
 * A missing table is an EXPECTED state, not an error: migration 0009 may not be
 * applied yet on a given deployment. Reporting it separately lets the page say
 * "this section is being set up" instead of throwing a 500 — and, just as
 * importantly, stops it from rendering as an innocent empty gallery, which
 * would look like "no adverts exist" when the truth is "the table is absent".
 */
export type AdvertisementsResult = {
  ads: Advertisement[];
  /** False when migration 0009 has not been applied to this database. */
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
/* reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Live adverts for the signed-in user. RLS limits this to ACTIVE rows inside
 * their window; the explicit filters are belt-and-braces and keep the query
 * plan on the live index.
 */
export async function listLiveAdvertisements(): Promise<AdvertisementsResult> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("advertisements")
    .select("*")
    .eq("status", "ACTIVE")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingTable(error)) return { ads: [], available: false };
    throw error;
  }

  return { ads: (data ?? []) as Advertisement[], available: true };
}

/**
 * What the PUBLIC gallery is allowed to read.
 *
 * Deliberately not `Advertisement`: migration 0013 grants `anon` the columns an
 * advert is rendered from and withholds `created_by`, so typing this as the full
 * row would promise a field the query can never return. Typing the narrow shape
 * makes that a compile-time fact rather than a comment.
 */
export type PublicAdvertisement = Omit<Advertisement, "created_by" | "updated_at">;

const PUBLIC_COLUMNS =
  "id, title, description, advertiser, image_url, link_url, alt_text, category, sort_order, status, starts_at, ends_at, created_at";

/**
 * Live adverts for the public site — the landing page, read by people who are
 * not signed in.
 *
 * Runs on the caller-scoped client, so the anonymous visitor is subject to RLS
 * exactly like anyone else and the ACTIVE/window rule stays in the database.
 * `created_by` is never selected, which is also why this works under 0013's
 * column-level grant instead of depending on a blanket table grant.
 *
 * A missing table (0009 or 0013 not yet applied) is reported as `available:
 * false`. The landing page must never 500 because a migration is pending: it is
 * the first page a stranger sees.
 */
export async function listPublicAdvertisements(limit = 8): Promise<{
  ads: PublicAdvertisement[];
  available: boolean;
}> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("advertisements")
    .select(PUBLIC_COLUMNS)
    .eq("status", "ACTIVE")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingTable(error)) return { ads: [], available: false };
    throw error;
  }

  return { ads: (data ?? []) as unknown as PublicAdvertisement[], available: true };
}

/** Every advert, including unpublished ones. Admin screens only. */
export async function listAllAdvertisements(): Promise<AdvertisementsResult> {
  const admin = createAdminSupabaseClient();

  const { data, error } = await admin
    .from("advertisements")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    if (isMissingTable(error)) return { ads: [], available: false };
    throw error;
  }

  return { ads: (data ?? []) as Advertisement[], available: true };
}

/* -------------------------------------------------------------------------- */
/* admin mutations — service role, audit-logged                               */
/* -------------------------------------------------------------------------- */

export async function upsertAdvertisement(input: {
  adminId: string;
  payload: Record<string, unknown>;
  advertisementId?: string;
}) {
  const admin = createAdminSupabaseClient();

  const record = {
    title: input.payload.title,
    description: input.payload.description ?? null,
    advertiser: input.payload.advertiser ?? null,
    image_url: input.payload.imageUrl,
    link_url: input.payload.linkUrl ?? null,
    alt_text: input.payload.altText ?? null,
    category: input.payload.category,
    sort_order: input.payload.sortOrder,
    status: input.payload.status,
    starts_at: input.payload.startsAt ?? null,
    ends_at: input.payload.endsAt ?? null,
    // Only stamped on create: an edit should not reassign authorship.
    ...(input.advertisementId ? {} : { created_by: input.adminId }),
  };

  const query = input.advertisementId
    ? admin
        .from("advertisements")
        .update(record)
        .eq("id", input.advertisementId)
        .select("id, title, status")
        .single()
    : admin.from("advertisements").insert(record).select("id, title, status").single();

  const { data, error } = await query;
  if (error) throw error;

  await admin.rpc("write_audit", {
    p_admin_id: input.adminId,
    p_user_id: null,
    p_action: input.advertisementId ? "ADVERTISEMENT_UPDATED" : "ADVERTISEMENT_CREATED",
    p_entity: "advertisement",
    p_entity_id: data.id,
    p_description: `${input.advertisementId ? "Updated" : "Created"} advertisement "${data.title}"`,
    p_metadata: { status: data.status, category: record.category },
    p_ip_hash: null,
    p_user_agent: null,
  });

  return data;
}

/**
 * Remove an advert.
 *
 * A hard delete, because an advert carries no financial history that has to
 * survive it — unlike a withdrawal, where deleting the row would erase the
 * record of a decision. "ARCHIVED" exists for hiding one whose history someone
 * may still want to read.
 */
export async function deleteAdvertisement(input: { adminId: string; advertisementId: string }) {
  const admin = createAdminSupabaseClient();

  const { data, error } = await admin
    .from("advertisements")
    .delete()
    .eq("id", input.advertisementId)
    .select("id, title")
    .single();

  if (error) throw error;

  await admin.rpc("write_audit", {
    p_admin_id: input.adminId,
    p_user_id: null,
    p_action: "ADVERTISEMENT_DELETED",
    p_entity: "advertisement",
    p_entity_id: data.id,
    p_description: `Deleted advertisement "${data.title}"`,
    p_metadata: {},
    p_ip_hash: null,
    p_user_agent: null,
  });

  return data;
}
