import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { ApiError, isMissingSchemaFailure } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import type { Video, VideoCampaign } from "@/lib/types";

/**
 * Video catalogue reads. Eligibility rules are *reported* here for the UI, but
 * they are enforced authoritatively inside public.video_start() and
 * public.video_complete_session().
 */

/**
 * A video's package context, as the watcher needs to see it.
 *
 * `null` means the video is in no package — it behaves as it always has, with no
 * purchase needed. Everything else here is REPORTED for the UI; the gate itself
 * lives in `video_start` and `video_complete_session`.
 */
export type VideoPackageInfo = {
  id: string;
  name: string;
  owned: boolean;
  dailyCap: number;
  earnedToday: number;
  /** When the daily allowance comes back. Null when the user does not hold it. */
  resetsAt: string | null;
};

export type VideoCard = Video & {
  campaign: VideoCampaign | null;
  rewardedToday: number;
  remainingToday: number;
  eligible: boolean;
  reason: string | null;
  package: VideoPackageInfo | null;
};

/**
 * How many videos a page of the catalogue carries.
 *
 * Every card is serialized into the page it is rendered on, so the row count IS
 * the payload: 305 rows produced a ~150KB flight payload — mostly JSON field
 * names, not content — and 305 cards of DOM. Both costs are removed by
 * returning a page and telling the client how many rows exist in total, so the
 * "show more" control can continue from where it left off.
 *
 * 24 is chosen so a phone renders the first screenful without a long main-thread
 * block while still making "show more" rare on a typical catalogue.
 */
export const VIDEO_PAGE_SIZE = 24;

/** A hard ceiling, so a hand-written `?limit=100000` cannot re-create the problem. */
const MAX_PAGE_SIZE = 60;

export type VideoPage = {
  items: VideoCard[];
  /** Total ACTIVE videos, not just those on this page. */
  total: number;
  offset: number;
  limit: number;
};

export async function listAvailableVideos(
  userId: string,
  options: { limit?: number; offset?: number; packageId?: string | null } = {},
): Promise<VideoPage> {
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(options.limit ?? VIDEO_PAGE_SIZE) || VIDEO_PAGE_SIZE),
  );
  const offset = Math.max(0, Math.floor(options.offset ?? 0) || 0);

  const supabase = await createServerSupabaseClient();

  /*
    `packageId` narrows the catalogue to ONE tier's videos, which is what the
    Watch & Earn page shows when the viewer taps WATCH on a package they hold.

    The filtering happens by listing the tier's video ids first and constraining
    the query with them, rather than by a join: every eligibility rule below then
    runs unchanged over a smaller set, so there is exactly one implementation of
    "is this video earnable" in the codebase and no second, subtly different copy
    for package-scoped browsing.
  */
  let packageVideoIds: string[] | null = null;
  if (options.packageId) {
    const { data: links, error: linksError } = await supabase
      .from("package_videos")
      .select("video_id")
      .eq("package_id", options.packageId);

    if (linksError) throw linksError;

    packageVideoIds = ((links ?? []) as { video_id: string }[]).map((row) => row.video_id);
    /*
      A tier with nothing attached returns an empty page rather than the whole
      catalogue. Falling through to an unfiltered query is the failure that
      matters here: it would show a buyer the entire platform while the heading
      says their package.
    */
    if (packageVideoIds.length === 0) return { items: [], total: 0, offset, limit };
  }

  /*
    `count: "exact"` rides along with the page request, so the total costs no
    extra round trip; `range` is what keeps the response proportional to what is
    actually shown.
  */
  let query = supabase
    .from("videos")
    .select("*", { count: "exact" })
    .eq("status", "ACTIVE")
    .order("created_at", { ascending: false });

  if (packageVideoIds) query = query.in("id", packageVideoIds);

  const { data: videos, error, count } = await query.range(offset, offset + limit - 1);

  if (error) throw error;
  const list = (videos ?? []) as Video[];
  if (list.length === 0) return { items: [], total: count ?? 0, offset, limit };

  const campaignIds = Array.from(
    new Set(list.map((v) => v.campaign_id).filter((id): id is string => Boolean(id))),
  );

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [campaignsRes, sessionsRes, packageLinksRes, purchasesRes] = await Promise.all([
    campaignIds.length > 0
      ? supabase.from("video_campaigns").select("*").in("id", campaignIds)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("video_watch_sessions")
      /*
        `package_id` is part of the key, not just the row: since 0020 a video can
        be watched once per PACKAGE per day, so counting by video alone would
        show a buyer their second tier as already spent.
      */
      .select("video_id, status, rewarded_at, package_id")
      .eq("user_id", userId)
      .eq("status", "REWARDED")
      .gte("rewarded_at", startOfToday.toISOString()),
    /*
      Which videos belong to a package (migration 0014). RLS hides rows whose
      package is not ACTIVE, so a draft tier's videos simply read as free — which
      is why a tier must be published before its videos can be seen as gated.
    */
    supabase
      .from("package_videos")
      .select("video_id, package_id, reward_amount")
      .in(
        "video_id",
        list.map((v) => v.id),
      ),
    supabase
      .from("user_packages")
      .select("package_id")
      .eq("user_id", userId)
      .eq("status", "ACTIVE"),
  ]);

  const campaigns = new Map(
    ((campaignsRes.data ?? []) as VideoCampaign[]).map((c) => [c.id, c]),
  );

  /*
    Counted per (video, package).

    The database's per-video daily limit is now scoped to the package, so the
    page must count the same way or it would tell a buyer holding two tiers that
    their second one is spent when the database will happily pay it. A video in
    no package keys on the empty string and behaves exactly as before.
  */
  const rewardedToday = new Map<string, number>();
  const sessionKey = (videoId: string, packageId: string | null) => `${videoId}:${packageId ?? ""}`;
  for (const row of (sessionsRes.data ?? []) as { video_id: string; package_id: string | null }[]) {
    const key = sessionKey(row.video_id, row.package_id);
    rewardedToday.set(key, (rewardedToday.get(key) ?? 0) + 1);
  }

  const now = Date.now();

  /* ------------------------------------------------------------------------ */
  /* package context                                                           */
  /* ------------------------------------------------------------------------ */

  /*
    Every tier gating a video, with that tier's own rate (0020).

    A video may now belong to several packages and pay a different figure in
    each, so there is no longer one package per video — the tier that applies is
    the one the VIEWER holds, and the page has to resolve that the same way
    `video_start` does or it will show a rate the database will not pay.
  */
  const packagesByVideo = new Map<string, { packageId: string; rate: number | null }[]>();
  for (const row of (packageLinksRes.data ?? []) as {
    video_id: string;
    package_id: string;
    reward_amount: number | null;
  }[]) {
    const bucket = packagesByVideo.get(row.video_id) ?? [];
    bucket.push({
      packageId: row.package_id,
      rate: row.reward_amount === null ? null : Number(row.reward_amount),
    });
    packagesByVideo.set(row.video_id, bucket);
  }

  const ownedPackageIds = new Set(
    ((purchasesRes.data ?? []) as { package_id: string }[]).map((row) => row.package_id),
  );

  /*
    Two different sets, deliberately, because they answer different questions.

    `packageIds` is only the tiers this user OWNS: the allowance RPC below is
    per-user, and there is nothing to compute for a tier they do not hold.

    The NAMES must cover every tier that locks a video on this page, owned or
    not, because the lock message is what names the tier to buy:

        "This video is part of the <name> package."

    Resolving names from the owned set alone meant the one person who actually
    sees that message — a non-owner — was the one person whose lookup came back
    empty, so every gated video read "part of the a package package". The tier
    name is the upsell, not a secret.
  */
  const allGatingIds = Array.from(
    new Set(Array.from(packagesByVideo.values()).flat().map((g) => g.packageId)),
  );

  const packageIds = allGatingIds.filter((id) => ownedPackageIds.has(id));

  /*
    Price as well as name, because with several tiers gating one video the lock
    message has to name ONE of them and the actionable one is the cheapest — the
    smallest step up, not the most expensive tier that happens to also gate it.
  */
  const tiers = new Map<string, { name: string; price: number }>();
  if (allGatingIds.length > 0) {
    const { data: rows } = await supabase
      .from("packages")
      .select("id, name, price")
      .in("id", allGatingIds);

    for (const tier of (rows ?? []) as { id: string; name: string; price: number }[]) {
      tiers.set(tier.id, { name: tier.name, price: Number(tier.price) });
    }
  }

  /*
    Allowance figures come from `package_daily_usage`, the single definition of
    the day boundary (midnight in Africa/Nairobi) and the same function the
    database uses to refuse a reward. Recomputing the day in JavaScript would let
    the countdown and the enforcement disagree.

    The RPC is service-role only BECAUSE it takes a user id, so it is called here
    with the already-authenticated user's own id and never with anything from a
    request.
  */
  const admin = createAdminSupabaseClient();
  const usage = new Map<
    string,
    { earnedToday: number; remaining: number; cap: number; resetsAt: string | null }
  >();

  await Promise.all(
    packageIds.map(async (packageId) => {
      const { data: rows, error: usageError } = await admin.rpc("package_daily_usage", {
        p_user_id: userId,
        p_package_id: packageId,
      });

      /*
        Migration 0014 may not be applied yet. The watch page must keep working
        in that state: a missing function means "no package accounting", which is
        exactly how the app behaved before packages existed. Any OTHER error is a
        real failure and is raised.
      */
      if (usageError) {
        if (isMissingSchemaFailure(usageError)) return;
        throw usageError;
      }

      const row = (Array.isArray(rows) ? rows[0] : rows) as Record<string, unknown> | null;
      usage.set(packageId, {
        earnedToday: Number(row?.earned_today ?? 0),
        remaining: Number(row?.remaining ?? 0),
        cap: Number(row?.daily_cap ?? 0),
        resetsAt: row?.resets_at ? String(row.resets_at) : null,
      });
    }),
  );

  const items = list.map((video) => {
    const campaign = video.campaign_id ? campaigns.get(video.campaign_id) ?? null : null;

    const gating = packagesByVideo.get(video.id) ?? [];

    /*
      Which tier applies to THIS viewer.

      The tier they hold that pays the most, matching `video_start` exactly — it
      picks the highest rate among held tiers and skips an exhausted one. Falling
      back to the cheapest tier they do NOT hold is only for the lock message, so
      the upsell names the smallest step rather than the largest number on the
      page.
    */
    const held = gating
      .filter((g) => ownedPackageIds.has(g.packageId))
      .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0));
    const lockCandidate = gating
      .filter((g) => !ownedPackageIds.has(g.packageId))
      .sort(
        (a, b) =>
          (tiers.get(a.packageId)?.price ?? Number.POSITIVE_INFINITY) -
          (tiers.get(b.packageId)?.price ?? Number.POSITIVE_INFINITY),
      )[0];
    const applied = held[0] ?? lockCandidate ?? gating[0] ?? null;

    /*
      The rate this viewer would actually be paid, and the figure every check
      below must use: a tier paying 30 is refused by the campaign whether it can
      still afford 10 or not, and the allowance is spent 30 at a time.
    */
    const rate = applied?.rate ?? Number(video.reward_amount);

    const packageId = applied?.packageId ?? null;
    const packageUsage = packageId ? usage.get(packageId) : undefined;
    const packageInfo: VideoPackageInfo | null = packageId
      ? {
          id: packageId,
          name: tiers.get(packageId)?.name ?? "a package",
          owned: ownedPackageIds.has(packageId),
          dailyCap: packageUsage?.cap ?? 0,
          earnedToday: packageUsage?.earnedToday ?? 0,
          resetsAt: packageUsage?.resetsAt ?? null,
        }
      : null;

    const done = rewardedToday.get(sessionKey(video.id, packageId)) ?? 0;
    const remaining = video.daily_limit > 0 ? Math.max(0, video.daily_limit - done) : Infinity;

    /*
      The allowance can only be spent while there is room for THIS video's
      reward: the database refuses a reward that would take the total past the
      cap, so a video costing more than what is left is not earnable today. That
      is the condition mirrored here, which is why the countdown appears one
      video early rather than letting the user watch and then be refused.
    */
    const allowanceExhausted = Boolean(
      packageInfo?.owned &&
        packageInfo.dailyCap > 0 &&
        packageInfo.earnedToday + rate > packageInfo.dailyCap,
    );

    let eligible = true;
    let reason: string | null = null;

    if (packageInfo && !packageInfo.owned) {
      eligible = false;
      reason = `This video is part of the ${packageInfo.name} package. Activate it to earn from this video.`;
    } else if (allowanceExhausted) {
      eligible = false;
      reason = `You have earned today's allowance from ${packageInfo?.name ?? "this package"}. It resets at midnight (East Africa Time).`;
    }

    if (video.total_view_limit !== null && video.total_views >= video.total_view_limit) {
      eligible = false;
      reason = "This campaign has reached its viewer limit.";
    } else if (campaign) {
      if (campaign.start_at && new Date(campaign.start_at).getTime() > now) {
        eligible = false;
        reason = "This campaign has not started yet.";
      } else if (campaign.end_at && new Date(campaign.end_at).getTime() < now) {
        eligible = false;
        reason = "This campaign has ended.";
      } else if (campaign.spent + rate > campaign.budget) {
        eligible = false;
        reason = "This campaign's reward budget is exhausted.";
      }
    } else if (video.daily_limit > 0 && remaining <= 0) {
      eligible = false;
      reason = "You have reached today's limit for this video.";
    }    if (eligible && video.daily_limit > 0 && remaining <= 0) {
      eligible = false;
      reason = "You have reached today's limit for this video.";
    }

    return {
      ...video,
      /*
        The rate this viewer earns, not the video's global figure. The watch page
        and the catalogue both read this, so what they show is what the database
        will pay.
      */
      reward_amount: rate,
      campaign,
      rewardedToday: done,
      remainingToday: Number.isFinite(remaining) ? remaining : -1,
      eligible,
      reason,
      package: packageInfo,
    };
  });

  return { items, total: count ?? items.length, offset, limit };
}

export type StartSessionResult = {
  sessionId: string;
  sessionToken: string;
  videoId: string;
  title: string;
  description: string | null;
  videoUrl: string;
  thumbnailUrl: string | null;
  durationSeconds: number;
  requiredWatchSeconds: number;
  rewardAmount: number;
  currency: string;
  startedAt: string;
  watchedSeconds: number;
  status: string;
  resumed: boolean;
};

export async function startVideoSession(input: {
  userId: string;
  videoId: string;
  ipHash: string | null;
  deviceHash: string | null;
}): Promise<StartSessionResult> {
  const admin = createAdminSupabaseClient();

  const { data, error } = await admin.rpc("video_start", {
    p_user_id: input.userId,
    p_video_id: input.videoId,
    p_ip_hash: input.ipHash,
    p_device_hash: input.deviceHash,
  });

  // Rethrown raw so the shared mapper converts the raised token into a safe
  // user-facing message.
  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) throw new ApiError("SESSION_NOT_CREATED", "The watch session could not be started.", 500);

  return {
    sessionId: String(row.session_id),
    sessionToken: String(row.session_token),
    videoId: String(row.video_id),
    title: String(row.title),
    description: (row.description as string | null) ?? null,
    videoUrl: String(row.video_url),
    thumbnailUrl: (row.thumbnail_url as string | null) ?? null,
    durationSeconds: Number(row.duration_seconds),
    requiredWatchSeconds: Number(row.required_watch_seconds),
    rewardAmount: Number(row.reward_amount),
    currency: String(row.currency),
    startedAt: String(row.started_at),
    watchedSeconds: Number(row.watched_seconds ?? 0),
    status: String(row.status),
    resumed: Boolean(row.resumed),
  };
}

export type ProgressResult = {
  watchedSeconds: number;
  requiredWatchSeconds: number;
  elapsedSeconds: number;
  status: string;
  ready: boolean;
};

export async function reportVideoProgress(input: {
  userId: string;
  sessionToken: string;
  watchedSeconds: number;
}): Promise<ProgressResult> {
  const admin = createAdminSupabaseClient();

  const { data, error } = await admin.rpc("video_progress", {
    p_user_id: input.userId,
    p_session_token: input.sessionToken,
    p_watched_seconds: input.watchedSeconds,
  });

  if (error) {
    /*
      `public.video_progress` declares its result columns as OUT parameters, one
      of which is named `watched_seconds`, and then referenced that name
      unqualified in its own UPDATE. PL/pgSQL cannot tell the parameter from the
      column, so the function raises 42702 on EVERY call it receives.

      The migration that fixes it (0011) may not yet be applied to a given
      environment — and because plpgsql bodies are parsed at *execution* time,
      the schema looks perfectly healthy while every progress report fails. That
      combination is worth one fallback: without it, watch progress is never
      recorded, the server-side watch-time gate can never be satisfied, and the
      user watches a full minute only to be told their session could not be
      verified. Which is exactly what it looked like.

      The fallback is deliberately narrow and non-financial:

        · it runs only for the schema faults above (an ambiguous column, a
          missing function) — never for a permission or connectivity error
        · it touches only `watched_seconds`, `last_activity_at` and `status`
        · it clamps the claim to the wall-clock time since the session started,
          which is what the function does, and
        · it decides nothing about money. `video_complete_session` re-checks the
          watch requirement against the database's own clock, so a fallback that
          round numbers up cannot produce a reward.

      Once 0011 is applied the function succeeds and this path stops being used.
    */
    if (!isVideoSchemaFault(error)) throw error;
    return progressWithoutDatabaseFunction(input);
  }

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) throw new ApiError("SESSION_NOT_FOUND", "That watch session has expired.", 404);

  return {
    watchedSeconds: Number(row.watched_seconds),
    requiredWatchSeconds: Number(row.required_watch_seconds),
    elapsedSeconds: Number(row.elapsed_seconds),
    status: String(row.status),
    ready: Boolean(row.ready),
  };
}

/** The error signatures that mean "this environment is missing migration 0011". */
function isVideoSchemaFault(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  const message = String((error as { message?: unknown })?.message ?? "");
  return (
    code === "42702" ||
    code === "PGRST202" ||
    code === "42883" ||
    /column reference .* is ambiguous/i.test(message) ||
    /function public\.video_progress\(.*\) does not exist/i.test(message)
  );
}

let warnedAboutMissingProgressFunction = false;

/**
 * Server-side equivalent of `public.video_progress`, used only when that
 * function cannot run. Not a reward path: it stores an elapsed-time claim.
 */
async function progressWithoutDatabaseFunction(input: {
  userId: string;
  sessionToken: string;
  watchedSeconds: number;
}): Promise<ProgressResult> {
  const admin = createAdminSupabaseClient();

  const { data: session } = await admin
    .from("video_watch_sessions")
    .select("id, status, started_at, watched_seconds, required_watch_seconds")
    .eq("session_token", input.sessionToken)
    .eq("user_id", input.userId)
    .maybeSingle<{
      id: string;
      status: string;
      started_at: string;
      watched_seconds: number | null;
      required_watch_seconds: number;
    }>();

  if (!session) {
    throw new ApiError("SESSION_NOT_FOUND", "That watch session has expired.", 404);
  }
  if (["REWARDED", "EXPIRED", "REJECTED", "SUSPENDED"].includes(session.status)) {
    throw new ApiError(
      "SESSION_NOT_FOUND",
      "That watch session has expired. Please start the video again.",
      404,
    );
  }

  const elapsedSeconds = Math.max(0, (Date.now() - new Date(session.started_at).getTime()) / 1000);
  const requiredWatchSeconds = Number(session.required_watch_seconds) || 0;

  // The same clamp the function applies: a client cannot claim more watch time
  // than has actually elapsed. The 1.5s allowance absorbs reporting jitter.
  const claimed = Math.min(Math.max(Number(input.watchedSeconds) || 0, 0), elapsedSeconds + 1.5);
  const watchedSeconds = Math.max(Number(session.watched_seconds) || 0, claimed);

  const { error } = await admin
    .from("video_watch_sessions")
    .update({
      watched_seconds: watchedSeconds,
      last_activity_at: new Date().toISOString(),
      status: "WATCHING",
    })
    .eq("id", session.id);

  if (error) {
    logger.error("video_progress_fallback_failed", { sessionId: session.id, error: error.message });
    throw error;
  }

  if (!warnedAboutMissingProgressFunction) {
    warnedAboutMissingProgressFunction = true;
    logger.warn("video_progress_function_unusable", {
      fallback: "storing progress server-side instead",
      fix: "apply migration 0011_progress_ambiguity.sql (npm run db:bundle, then db:push-sql)",
    });
  }

  return {
    watchedSeconds,
    requiredWatchSeconds,
    elapsedSeconds,
    status: "WATCHING",
    ready: watchedSeconds >= requiredWatchSeconds && elapsedSeconds >= requiredWatchSeconds,
  };
}

export type CompletionResult = {
  status: string;
  rewardAmount: number | null;
  currency: string;
  transactionId: string | null;
  reference: string | null;
  watchedSeconds: number;
  rejectReason: string | null;
  duplicate: boolean;
};

export async function completeVideoSession(input: {
  userId: string;
  sessionToken: string;
}): Promise<CompletionResult> {
  const admin = createAdminSupabaseClient();

  /*
    Bring the stored watch time up to date first, from the server's own clock.

    `video_complete_session` requires `watched_seconds >= required_watch_seconds`
    as well as its own elapsed-time check, and it treats a shortfall as terminal:
    the session is marked REJECTED and a WATCH_TIME_MISMATCH fraud event is filed.
    So a completion that arrives with a stale watch time does not just fail — it
    destroys the session and penalises the user.

    Stale is the normal case, not an edge case. Progress is reported on a timer
    that browsers throttle in a background tab, and the completion path can be
    reached by a recovery job rather than a browser at all. Refreshing here means
    the claim handed to the database is always the most the server is willing to
    allow: the number passed below is deliberately absurd, because the clamp
    (`least(claimed, elapsed + 1.5)`) reduces it to real elapsed time. Nothing
    here can invent watch time — it only stops real watch time being forgotten.

    A failure is ignored on purpose: if the session is already terminal, the call
    below is what reports that, with the right status and message.
  */
  try {
    await reportVideoProgress({
      userId: input.userId,
      sessionToken: input.sessionToken,
      watchedSeconds: Number.MAX_SAFE_INTEGER,
    });
  } catch {
    /* the completion call below reports the real reason */
  }

  const { data, error } = await admin.rpc("video_complete_session", {
    p_user_id: input.userId,
    p_session_token: input.sessionToken,
  });

  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) throw new ApiError("SESSION_NOT_FOUND", "That watch session has expired.", 404);

  return {
    status: String(row.result_status),
    rewardAmount: row.reward_amount === null ? null : Number(row.reward_amount),
    currency: String(row.currency ?? "KES"),
    transactionId: (row.transaction_id as string | null) ?? null,
    reference: (row.reference as string | null) ?? null,
    watchedSeconds: Number(row.watched_seconds ?? 0),
    rejectReason: (row.reject_reason as string | null) ?? null,
    duplicate: Boolean(row.duplicate),
  };
}

/**
 * Recovery path for /api/rewards/process.
 *
 * If a client dropped out after satisfying the watch requirement, the server
 * can still settle the session. It re-runs the exact same authoritative
 * completion function, so a session is never rewarded twice.
 */
export async function processPendingRewards(userId: string) {
  const admin = createAdminSupabaseClient();

  const { data: pending } = await admin
    .from("video_watch_sessions")
    .select("session_token, required_watch_seconds, started_at, watched_seconds, status")
    .eq("user_id", userId)
    .in("status", ["STARTED", "WATCHING"])
    .order("started_at", { ascending: false })
    .limit(20);

  const results: CompletionResult[] = [];

  for (const row of (pending ?? []) as {
    session_token: string;
    required_watch_seconds: number;
    started_at: string;
    watched_seconds: number;
    status: string;
  }[]) {
    const elapsed = (Date.now() - new Date(row.started_at).getTime()) / 1000;
    if (elapsed < row.required_watch_seconds || Number(row.watched_seconds) < row.required_watch_seconds) {
      continue;
    }
    results.push(
      await completeVideoSession({ userId, sessionToken: row.session_token }),
    );
  }

  const credited = results.filter((r) => r.status === "REWARDED");
  return {
    processed: results.length,
    credited: credited.length,
    totalCredited: credited.reduce((sum, r) => sum + (r.rewardAmount ?? 0), 0),
    results,
  };
}

export async function getVideoRewardHistory(userId: string, limit = 20) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("video_watch_sessions")
    .select("id, video_id, status, watched_seconds, reward_amount, rewarded_at, reject_reason, videos(title)")
    .eq("user_id", userId)
    .eq("status", "REWARDED")
    .order("rewarded_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}
