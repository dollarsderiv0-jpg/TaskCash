import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {
  amountBand,
  maskCountry,
  maskName,
  type ActivityKind,
  type RecentActivityItem,
} from "@/lib/activity/mask";
import { selectRecentWindow } from "@/lib/activity/window";

/**
 * Recent money movements, MASKED, for the signed-in activity ticker.
 *
 * WHY THIS FILE IS SO CAREFUL
 * ---------------------------
 * A ticker like this is the one feature on the platform that renders one
 * customer's financial activity to another customer. Every other read in this
 * codebase is scoped to the caller; this one deliberately is not, so the masking
 * is not decoration — it is the entire reason the feature is safe to ship. The
 * rules themselves live in `lib/activity/mask.ts`, where they are pure and
 * directly tested; this file's job is to fetch rows and apply them. The one
 * other decision — which rows survive the window — lives in
 * `lib/activity/window.ts` for the same reason.
 *
 *   1. An AMOUNT never leaves. Only the band it fell in.
 *   2. An IDENTITY never leaves. Only a first name, an initial and a country.
 *   3. Only COMPLETED movements count, and only ones with a completion time. A
 *      PENDING row is somebody's intention, and publishing an intention that may
 *      still fail is a claim about money that has not moved.
 *
 * The service-role client is required because RLS correctly stops one customer
 * reading another's deposits — which is also why the two queries run separately
 * and the join happens here. An embedded `profiles(full_name, country)` select
 * would be more concise and would also hand a whole profile row to a function
 * whose entire job is not to do that.
 */

export type RecentActivityResult = {
  items: RecentActivityItem[];
  /**
   * False when the tables behind this could not be read. Reported rather than
   * thrown so a pending migration renders as an invisible ticker instead of a
   * broken dashboard — the dashboard must not 500 because a section is empty.
   */
  available: boolean;
};

/** How far back "recent" reaches. Long enough to be non-empty on a quiet day. */
const WINDOW_HOURS = 72;

/** Rows fetched per table before merging. The caller's limit trims after. */
const FETCH_LIMIT = 40;

type ActivityRow = {
  user_id: string;
  amount: number | string;
  currency: string;
  completed_at: string | null;
  created_at: string;
};

/** A row paired with the kind it represents, and proven to have completed. */
type Movement = { row: ActivityRow; kind: ActivityKind; at: string };

type ProfileRow = { id: string; full_name: string | null; country: string | null };

/**
 * A row becomes a movement only if it has a completion time. A row without one
 * has not completed, whatever its status column says, and is dropped here rather
 * than backdated to created_at — which would date a payment to the moment
 * somebody first asked for it.
 *
 * Deciding this once, here, is also what keeps an undated row from taking a slot
 * in the window: `undefined` never reaches `selectRecentWindow`.
 */
function toMovement(row: ActivityRow, kind: ActivityKind): Movement | null {
  if (!row.completed_at) return null;
  return { row, kind, at: row.completed_at };
}

function toItem(movement: Movement, profiles: Map<string, ProfileRow>): RecentActivityItem {
  const { row, kind } = movement;
  const amount = typeof row.amount === "string" ? Number(row.amount) : row.amount;
  const { bandMin, bandMax } = amountBand(amount);
  const profile = profiles.get(row.user_id);

  return {
    kind,
    displayName: maskName(profile?.full_name),
    country: maskCountry(profile?.country),
    bandMin,
    bandMax,
    currency: row.currency,
    at: movement.at,
  };
}

/**
 * The masked feed, newest first, with both kinds represented when both exist.
 */
export async function listRecentActivity(options: {
  viewerProfileId: string;
  limit?: number;
}): Promise<RecentActivityResult> {
  const limit = Math.min(Math.max(options.limit ?? 24, 1), 50);
  const admin = createAdminSupabaseClient();
  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const columns = "user_id, amount, currency, completed_at, created_at";
  const recent = { ascending: false as const };

  const [deposits, withdrawals] = await Promise.all([
    admin
      .from("deposits")
      .select(columns)
      .eq("status", "COMPLETED")
      .gte("created_at", since)
      .order("created_at", recent)
      .limit(FETCH_LIMIT),
    admin
      .from("withdrawals")
      .select(columns)
      .eq("status", "COMPLETED")
      .gte("created_at", since)
      .order("created_at", recent)
      .limit(FETCH_LIMIT),
  ]);

  const depositRows = (deposits.data ?? []) as unknown as ActivityRow[];
  const withdrawalRows = (withdrawals.data ?? []) as unknown as ActivityRow[];

  // Unreadable only when BOTH failed. One failing table must not blank a ticker
  // the other could still fill.
  if (deposits.error && withdrawals.error) {
    return { items: [], available: false };
  }

  const movements = [
    ...depositRows.map((row) => toMovement(row, "DEPOSIT")),
    ...withdrawalRows.map((row) => toMovement(row, "WITHDRAWAL")),
  ].filter((movement): movement is Movement => movement !== null);

  /*
    The viewer's own movements are excluded: this reads as what the community is
    doing, and "you deposited" rotating beside your neighbours is noise, not
    social proof. It also means a fresh account sees an empty ticker rather than
    a feed built from its own test deposits — the honest state of a platform with
    no traffic yet.
  */
  const visible = movements.filter((movement) => movement.row.user_id !== options.viewerProfileId);

  const uniqueUserIds = [...new Set(visible.map((movement) => movement.row.user_id))];
  if (uniqueUserIds.length === 0) return { items: [], available: true };

  /*
    Only the two columns the mask needs. `full_name` is reduced to "Mary K." and
    `country` to two letters below, and nothing else from the profile is read —
    so a mistake downstream cannot leak a field that was never fetched.
  */
  const { data: profileRows, error: profileError } = await admin
    .from("profiles")
    .select("id, full_name, country")
    .in("id", uniqueUserIds);

  if (profileError) {
    // Without names there is no ticker worth rendering, and returning bare
    // amounts would be worse than returning nothing.
    return { items: [], available: false };
  }

  const profiles = new Map<string, ProfileRow>(
    ((profileRows ?? []) as ProfileRow[]).map((profile) => [profile.id, profile]),
  );

  /*
    The window, not the newest `limit` rows overall — see lib/activity/window.ts
    for why those differ, and why the difference is the whole point.
  */
  const items = selectRecentWindow(visible, limit).map((movement) =>
    toItem(movement, profiles),
  );

  return { items, available: true };
}
