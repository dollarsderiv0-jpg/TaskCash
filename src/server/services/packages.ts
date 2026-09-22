import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { getSetting } from "@/lib/settings";
import type { Package, PackageWithUsage, UserPackage } from "@/lib/types";

/**
 * Packages — paid earning tiers with a per-package daily cap (migration 0014).
 *
 * What this service is NOT allowed to decide:
 *
 *   · the price      — read from `packages`
 *   · the daily cap  — read from `packages`, snapshotted onto `user_packages`
 *   · whether a purchase succeeded — `package_purchase` posts the ledger row and
 *     returns the authoritative balance
 *
 * A caller supplies a package id and nothing else. `package_purchase` is
 * SECURITY DEFINER and executable only by the service role, so a client that
 * reaches this code path still cannot buy anything without going through it.
 */

const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205", "PGRST204"]);
const MISSING_TABLE_TEXT = /could not find the table|does not exist/i;

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code && MISSING_TABLE_CODES.has(error.code)) return true;
  return MISSING_TABLE_TEXT.test(error.message ?? "");
}

/** Numeric columns arrive from PostgREST as strings on some drivers. */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/* -------------------------------------------------------------------------- */
/* the buyer's view                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The published tiers, each annotated with what it means for THIS user.
 *
 * Read through the caller-scoped client, so RLS decides what is visible: only
 * ACTIVE packages, only their own purchases. The usage figures come from
 * `package_daily_usage`, which is service-role-only BECAUSE it takes a user id —
 * granting it to authenticated would let anyone read anyone's earnings. Passing
 * the authenticated user's own id from here is what keeps that safe, so this
 * function must never be called with a user id taken from a request.
 */
export async function listPackageCatalogue(userId: string): Promise<{
  packages: PackageWithUsage[];
  available: boolean;
  serverTime: string;
}> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("packages")
    .select("*")
    .eq("status", "ACTIVE")
    .order("sort_order", { ascending: true })
    .order("price", { ascending: true });

  if (error) {
    if (isMissingTable(error)) return { packages: [], available: false, serverTime: new Date().toISOString() };
    throw error;
  }

  const tiers = (data ?? []) as Package[];
  if (tiers.length === 0) {
    return { packages: [], available: true, serverTime: new Date().toISOString() };
  }

  const ids = tiers.map((t) => t.id);

  const [purchasesRes, videoCountsRes] = await Promise.all([
    supabase
      .from("user_packages")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "ACTIVE"),
    supabase.from("package_videos").select("package_id").in("package_id", ids),
  ]);

  if (purchasesRes.error && !isMissingTable(purchasesRes.error)) throw purchasesRes.error;
  if (videoCountsRes.error && !isMissingTable(videoCountsRes.error)) throw videoCountsRes.error;

  const purchases = new Map(
    ((purchasesRes.data ?? []) as UserPackage[]).map((p) => [p.package_id, p]),
  );

  const videoCounts = new Map<string, number>();
  for (const row of (videoCountsRes.data ?? []) as { package_id: string }[]) {
    videoCounts.set(row.package_id, (videoCounts.get(row.package_id) ?? 0) + 1);
  }

  // `package_daily_usage` is the single definition of the day boundary, so the
  // figure shown here is the figure the database enforces. One call per held
  // package — at most a handful.
  const admin = createAdminSupabaseClient();
  const usage = new Map<
    string,
    {
      earnedToday: number;
      remainingToday: number;
      resetsAt: string | null;
      earnedTotal: number;
      lifetimeRemaining: number | null;
    }
  >();

  await Promise.all(
    tiers
      .filter((tier) => purchases.has(tier.id))
      .map(async (tier) => {
        const { data: usageRows, error: usageError } = await admin.rpc("package_daily_usage", {
          p_user_id: userId,
          p_package_id: tier.id,
        });

        if (usageError) throw usageError;

        const row = (Array.isArray(usageRows) ? usageRows[0] : usageRows) as
          | Record<string, unknown>
          | null;

        usage.set(tier.id, {
          earnedToday: num(row?.earned_today),
          remainingToday: num(row?.remaining),
          resetsAt: row?.resets_at ? String(row.resets_at) : null,
          earnedTotal: num(row?.earned_total),
          /*
            Kept null rather than coerced. `num()` turns a null ceiling into 0, and
            "nothing left to earn" is the opposite of "no ceiling at all" — the UI
            would then tell a buyer on an uncapped tier that they are finished.
          */
          lifetimeRemaining:
            row?.lifetime_remaining === null || row?.lifetime_remaining === undefined
              ? null
              : num(row.lifetime_remaining),
        });
      }),
  );

  return {
    available: true,
    serverTime: new Date().toISOString(),
    packages: tiers.map((tier) => {
      const purchase = purchases.get(tier.id);
      const used = usage.get(tier.id);

      return {
        ...tier,
        price: num(tier.price),
        daily_earning_cap: num(tier.daily_earning_cap),
        owned: Boolean(purchase),
        purchasedAt: purchase?.purchased_at ?? null,
        /*
          The cap that applies is the PURCHASE's snapshot, not the tier's current
          figure, for the same reason the database uses the snapshot: an admin
          changing the tier must not silently change what a user already paid for.
        */
        earnedToday: used?.earnedToday ?? 0,
        remainingToday: purchase
          ? (used?.remainingToday ?? num(purchase.daily_earning_cap))
          : num(tier.daily_earning_cap),
        resetsAt: purchase ? (used?.resetsAt ?? null) : null,
        videoCount: videoCounts.get(tier.id) ?? 0,
        earnedTotal: used?.earnedTotal ?? 0,
        /*
          The purchase's own snapshot is what the page must show, exactly as the
          database enforces it: a tier re-priced after the sale cannot move the
          ceiling or the term of a purchase already made.
        */
        lifetimeRemaining: purchase
          ? (used?.lifetimeRemaining ?? null)
          : (tier.lifetime_earning_cap ?? null),
        expiresAt: purchase?.expires_at ?? null,
      };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* the deposit bonus, as the settlement function will pay it                   */
/* -------------------------------------------------------------------------- */

export type DepositBonusTier = { min: number; bonus: number };

/**
 * The deposit bonus tiers read from `system_settings`, which is the SAME row
 * `apply_deposit_bonus` reads.
 *
 * This exists because the packages page used to carry its own hardcoded copy of
 * the tiers — four entries, including the 15,000 deposit that was to be credited
 * a 25,000 bonus. A page that advertises a bonus the settlement function will not
 * pay is worse than one that advertises none, so the copy is derived from the
 * setting rather than written beside it.
 *
 * Sorted descending by `min` here too: the rule is "first match wins", and the
 * client picks the first entry whose threshold the price clears.
 */
export async function listDepositBonusTiers(): Promise<DepositBonusTier[]> {
  const raw = await getSetting("deposit_bonus.tiers");
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => {
      const value = (entry ?? {}) as { min?: unknown; bonus?: unknown };
      return { min: Number(value.min), bonus: Number(value.bonus) };
    })
    .filter((tier) => Number.isFinite(tier.min) && Number.isFinite(tier.bonus) && tier.bonus > 0)
    .sort((a, b) => b.min - a.min);
}

/* -------------------------------------------------------------------------- */
/* buying                                                                     */
/* -------------------------------------------------------------------------- */

export type PurchaseResult = {
  purchaseId: string;
  packageId: string;
  packageName: string;
  pricePaid: number;
  currency: string;
  dailyEarningCap: number;
  transactionId: string;
  reference: string;
  availableBalance: number;
};

/**
 * Buy a package. The ONLY way a package becomes active.
 *
 * Every rule — the tier being on sale, a configured allowance, no duplicate
 * active purchase, the currency matching, and the debit itself — is enforced
 * inside `package_purchase` under an advisory lock. If the debit fails (most
 * often INSUFFICIENT_AVAILABLE_BALANCE) the transaction rolls back and no
 * purchase row survives, so the user is never left holding a tier they did not
 * pay for, and never charged for one they did not get.
 *
 * Any error is rethrown raw: the shared mapper turns the raised token into a
 * safe message, which is what stops raw Postgres text reaching a user.
 */
export async function purchasePackage(input: {
  userId: string;
  packageId: string;
}): Promise<PurchaseResult> {
  const admin = createAdminSupabaseClient();

  const { data, error } = await admin.rpc("package_purchase", {
    p_user_id: input.userId,
    p_package_id: input.packageId,
  });

  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) {
    throw new ApiError(
      "PURCHASE_NOT_COMPLETED",
      "We could not complete that purchase. Please try again.",
      500,
    );
  }

  return {
    purchaseId: String(row.purchase_id),
    packageId: String(row.package_id),
    packageName: String(row.package_name),
    pricePaid: num(row.price_paid),
    currency: String(row.currency),
    dailyEarningCap: num(row.daily_earning_cap),
    transactionId: String(row.transaction_id),
    reference: String(row.reference),
    availableBalance: num(row.available_balance),
  };
}

/**
 * The tier a direct M-Pesa payment is for, and the price to charge for it.
 *
 * This exists so that "pay for this package with M-Pesa" cannot be talked into
 * charging the wrong amount. The price is read from the package row HERE and
 * nowhere else: the request carries a package id and no amount, because a
 * client-supplied amount is the one field that would let a buyer pay KES 10 for
 * a KES 7,500 tier.
 *
 * The refusals mirror `package_purchase` exactly, so a tier that cannot be
 * bought from a wallet balance cannot be bought by M-Pesa either — and the
 * refusal arrives before a deposit row is written, so a rejected request leaves
 * no payment in the customer's history.
 */
export async function resolvePayableTier(input: {
  userId: string;
  packageId: string;
  currency: string;
}): Promise<{ id: string; name: string; price: number; currency: string }> {
  const admin = createAdminSupabaseClient();

  const { data: tier, error } = await admin
    .from("packages")
    .select("id, name, price, currency, daily_earning_cap, status")
    .eq("id", input.packageId)
    .maybeSingle<Package>();

  if (error) throw error;

  if (!tier) {
    throw new ApiError("PACKAGE_NOT_FOUND", "That package could not be found.", 404);
  }

  /*
    DRAFT and PAUSED alike: `listPackageCatalogue` shows only ACTIVE tiers, so a
    tier refused here is one the buyer could not have seen anyway. Checked
    server-side rather than trusted from the page, because the id is the only
    thing the request carries and an id is trivial to guess from the catalogue.
  */
  if (tier.status !== "ACTIVE" || num(tier.daily_earning_cap) <= 0) {
    throw new ApiError(
      "PACKAGE_NOT_AVAILABLE",
      "This package is not available right now. Please check back shortly.",
      409,
    );
  }

  if (tier.currency !== input.currency) {
    throw new ApiError(
      "PACKAGE_CURRENCY_MISMATCH",
      "This package is priced in a different currency than your wallet.",
      409,
    );
  }

  const price = num(tier.price);
  if (!(price > 0)) {
    throw new ApiError(
      "PACKAGE_NOT_AVAILABLE",
      "This package is not available right now. Please check back shortly.",
      409,
    );
  }

  const { data: held } = await admin
    .from("user_packages")
    .select("id")
    .eq("user_id", input.userId)
    .eq("package_id", input.packageId)
    .eq("status", "ACTIVE")
    .maybeSingle<{ id: string }>();

  if (held) {
    throw new ApiError("PACKAGE_ALREADY_ACTIVE", "You already have this package active.", 409);
  }

  return { id: tier.id, name: tier.name, price, currency: tier.currency };
}

/* -------------------------------------------------------------------------- */
/* admin                                                                      */
/* -------------------------------------------------------------------------- */

/** Every tier, including drafts. Admin screens only. */
export async function listAllPackages(): Promise<{
  packages: PackageWithUsage[];
  available: boolean;
}> {
  const admin = createAdminSupabaseClient();

  const { data, error } = await admin
    .from("packages")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("price", { ascending: true })
    .limit(500);

  if (error) {
    if (isMissingTable(error)) return { packages: [], available: false };
    throw error;
  }

  const tiers = (data ?? []) as Package[];
  if (tiers.length === 0) return { packages: [], available: true };

  const { data: links, error: linksError } = await admin
    .from("package_videos")
    .select("package_id")
    .in(
      "package_id",
      tiers.map((t) => t.id),
    );

  if (linksError && !isMissingTable(linksError)) throw linksError;

  const counts = new Map<string, number>();
  for (const row of (links ?? []) as { package_id: string }[]) {
    counts.set(row.package_id, (counts.get(row.package_id) ?? 0) + 1);
  }

  const { data: purchaseRows, error: purchaseError } = await admin
    .from("user_packages")
    .select("package_id, status");

  if (purchaseError && !isMissingTable(purchaseError)) throw purchaseError;

  const holders = new Map<string, number>();
  for (const row of (purchaseRows ?? []) as { package_id: string; status: string }[]) {
    if (row.status !== "ACTIVE") continue;
    holders.set(row.package_id, (holders.get(row.package_id) ?? 0) + 1);
  }

  return {
    available: true,
    packages: tiers.map((tier) => ({
      ...tier,
      price: num(tier.price),
      daily_earning_cap: num(tier.daily_earning_cap),
      owned: false,
      purchasedAt: null,
      earnedToday: 0,
      remainingToday: 0,
      resetsAt: null,
      videoCount: counts.get(tier.id) ?? 0,
      // Reused to carry the holder count to the admin table; the buyer-facing
      // type has no field for it and the admin screen is the only consumer.
      holders: holders.get(tier.id) ?? 0,
    })) as unknown as PackageWithUsage[],
  };
}

export async function upsertPackage(input: {
  adminId: string;
  payload: Record<string, unknown>;
  packageId?: string;
}) {
  const admin = createAdminSupabaseClient();

  const record = {
    name: input.payload.name,
    description: input.payload.description ?? null,
    price: input.payload.price,
    currency: input.payload.currency,
    daily_earning_cap: input.payload.dailyEarningCap,
    /*
      Both are null-or-positive, and pass through untouched: a 0 here is a tier that
      can never pay, or one that lapses the instant it is bought, and the database
      rejects it rather than letting it be sold.
    */
    lifetime_earning_cap: input.payload.lifetimeEarningCap ?? null,
    duration_days: input.payload.durationDays ?? null,
    status: input.payload.status,
    sort_order: input.payload.sortOrder,
    ...(input.packageId ? {} : { created_by: input.adminId }),
  };

  const query = input.packageId
    ? admin.from("packages").update(record).eq("id", input.packageId).select("id, name, status").single()
    : admin.from("packages").insert(record).select("id, name, status").single();

  const { data, error } = await query;
  if (error) throw error;

  /*
    Video membership is replaced wholesale when supplied: the form submits the
    complete set, and diffing would leave a removed video attached. A video can
    only be in one package (unique index), so attaching one that belongs to
    another tier raises — which is the correct outcome, and the message says so
    rather than silently stealing it.
  */
  const videoIds = input.payload.videoIds;
  if (Array.isArray(videoIds)) {
    const { error: clearError } = await admin
      .from("package_videos")
      .delete()
      .eq("package_id", data.id);

    if (clearError && !isMissingTable(clearError)) throw clearError;

    if (videoIds.length > 0) {
      const { error: attachError } = await admin.from("package_videos").insert(
        (videoIds as string[]).map((videoId, index) => ({
          package_id: data.id,
          video_id: videoId,
          sort_order: (index + 1) * 10,
        })),
      );

      if (attachError) {
        if (attachError.code === "23505") {
          throw new ApiError(
            "VIDEO_ALREADY_PACKAGED",
            "One of those videos already belongs to another package. A video can only be in one package at a time.",
            409,
          );
        }
        throw attachError;
      }
    }
  }

  await admin.rpc("write_audit", {
    p_admin_id: input.adminId,
    p_user_id: null,
    p_action: input.packageId ? "PACKAGE_UPDATED" : "PACKAGE_CREATED",
    p_entity: "package",
    p_entity_id: data.id,
    p_description: `${input.packageId ? "Updated" : "Created"} package "${data.name}"`,
    p_metadata: {
      status: data.status,
      price: record.price,
      dailyEarningCap: record.daily_earning_cap,
      videoCount: Array.isArray(videoIds) ? videoIds.length : null,
    },
    p_ip_hash: null,
    p_user_agent: null,
  });

  return data;
}

/**
 * Remove a tier.
 *
 * Refused when anyone holds it: `user_packages.package_id` is `on delete
 * restrict`, so the database blocks the delete and the foreign-key error is
 * translated into the action the admin should take instead. Deleting a sold
 * package would orphan the record of what those users paid for.
 */
export async function deletePackage(input: { adminId: string; packageId: string }) {
  const admin = createAdminSupabaseClient();

  const { data, error } = await admin
    .from("packages")
    .delete()
    .eq("id", input.packageId)
    .select("id, name")
    .single();

  if (error) {
    if (error.code === "23503") {
      throw new ApiError(
        "PACKAGE_IN_USE",
        "This package has been purchased by at least one user, so it cannot be deleted. Archive it instead — existing purchases keep the terms they bought.",
        409,
      );
    }
    throw error;
  }

  await admin.rpc("write_audit", {
    p_admin_id: input.adminId,
    p_user_id: null,
    p_action: "PACKAGE_DELETED",
    p_entity: "package",
    p_entity_id: data.id,
    p_description: `Deleted package "${data.name}"`,
    p_metadata: {},
    p_ip_hash: null,
    p_user_agent: null,
  });

  return data;
}

/**
 * The videos an admin can attach, with the package each already belongs to.
 *
 * `packagedBy` is what makes the one-video-one-package rule visible in the form:
 * a video already attached elsewhere is shown as unavailable for this tier
 * rather than failing on save with a unique-violation.
 */
export async function listVideoOptions(): Promise<
  { id: string; title: string; status: string; rewardAmount: number; packagedBy: string | null }[]
> {
  const admin = createAdminSupabaseClient();

  const [videosRes, linksRes] = await Promise.all([
    admin
      .from("videos")
      .select("id, title, status, reward_amount")
      .order("title", { ascending: true })
      .limit(5000),
    admin.from("package_videos").select("video_id, package_id").limit(50_000),
  ]);

  if (videosRes.error) throw videosRes.error;
  if (linksRes.error && !isMissingTable(linksRes.error)) throw linksRes.error;

  const owner = new Map<string, string>();
  for (const row of (linksRes.data ?? []) as { video_id: string; package_id: string }[]) {
    owner.set(row.video_id, row.package_id);
  }

  return ((videosRes.data ?? []) as {
    id: string;
    title: string;
    status: string;
    reward_amount: unknown;
  }[]).map((video) => ({
    id: video.id,
    title: video.title,
    status: video.status,
    rewardAmount: num(video.reward_amount),
    packagedBy: owner.get(video.id) ?? null,
  }));
}

/** The ids attached to each package, for the admin editor. */
export async function listPackageVideoIds(): Promise<Record<string, string[]>> {
  const admin = createAdminSupabaseClient();

  const { data, error } = await admin
    .from("package_videos")
    .select("package_id, video_id")
    .limit(50_000);

  if (error) {
    if (isMissingTable(error)) return {};
    throw error;
  }

  const map: Record<string, string[]> = {};
  for (const row of (data ?? []) as { package_id: string; video_id: string }[]) {
    (map[row.package_id] ??= []).push(row.video_id);
  }
  return map;
}
