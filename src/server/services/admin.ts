import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { ApiError } from "@/lib/api/errors";
import type {
  Deposit,
  FraudEvent,
  Profile,
  WalletTransaction,
  Withdrawal,
} from "@/lib/types";

/**
 * Admin data access.
 *
 * Every function here is called only from routes that have already passed
 * requireAdmin(), and every read is paginated server-side so a screen never
 * tries to load the whole table.
 */

export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type AdminFilters = {
  page?: number;
  pageSize?: number;
  status?: string | null;
  search?: string | null;
  from?: string | null;
  to?: string | null;
};

function paginate(page = 1, pageSize = 25) {
  const safePage = Math.max(1, page);
  const safeSize = Math.min(100, Math.max(1, pageSize));
  return { safePage, safeSize, from: (safePage - 1) * safeSize, to: (safePage - 1) * safeSize + safeSize - 1 };
}

async function profilesByIds(ids: string[]) {
  if (ids.length === 0) return new Map<string, Partial<Profile>>();
  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("profiles")
    .select("id, full_name, email, phone, country, currency, status, kyc_status, role, risk_status, risk_score, created_at")
    .in("id", ids);

  return new Map(((data ?? []) as Profile[]).map((p) => [p.id, p]));
}

/**
 * Profile ids whose email, phone or name contains the term.
 *
 * Capped at 50: this feeds an `in (...)` clause for a search box, not a report,
 * and an unbounded id list would make a broad term turn into a slow query.
 */
async function profilesMatching(term: string): Promise<string[]> {
  const admin = createAdminSupabaseClient();
  const safe = term.replace(/[%,()]/g, "");
  if (!safe) return [];

  const { data, error } = await admin
    .from("profiles")
    .select("id")
    .or(`email.ilike.%${safe}%,phone.ilike.%${safe}%,full_name.ilike.%${safe}%`)
    .limit(50);

  if (error) return [];
  return ((data ?? []) as { id: string }[]).map((row) => row.id);
}

/* -------------------------------------------------------------------------- */
/* Withdrawals                                                                */
/* -------------------------------------------------------------------------- */

export type AdminWithdrawalRow = Withdrawal & {
  user: Partial<Profile> | null;
  accountAgeDays: number;
  depositCount: number;
};

export async function listAdminWithdrawals(filters: AdminFilters): Promise<Page<AdminWithdrawalRow>> {
  const admin = createAdminSupabaseClient();
  const { safePage, safeSize, from, to } = paginate(filters.page, filters.pageSize);

  let query = admin
    .from("withdrawals")
    .select("*", { count: "exact" })
    .order("requested_at", { ascending: false })
    .range(from, to);

  if (filters.status && filters.status !== "ALL") query = query.eq("status", filters.status);
  if (filters.from) query = query.gte("requested_at", filters.from);
  if (filters.to) query = query.lte("requested_at", filters.to);

  const { data, error, count } = await query;
  if (error) throw error;

  const rows = (data ?? []) as Withdrawal[];
  const profiles = await profilesByIds(rows.map((r) => r.user_id));

  // Deposit counts give the reviewer context without loading full histories.
  const depositCounts = new Map<string, number>();
  if (rows.length > 0) {
    const { data: deposits } = await admin
      .from("deposits")
      .select("user_id")
      .eq("status", "COMPLETED")
      .in("user_id", Array.from(new Set(rows.map((r) => r.user_id))));
    for (const row of (deposits ?? []) as { user_id: string }[]) {
      depositCounts.set(row.user_id, (depositCounts.get(row.user_id) ?? 0) + 1);
    }
  }

  const now = Date.now();
  const items = rows.map((row) => {
    const profile = profiles.get(row.user_id) ?? null;
    const created = profile?.created_at ? new Date(profile.created_at).getTime() : now;
    return {
      ...row,
      user: profile,
      accountAgeDays: Math.floor((now - created) / (24 * 3600 * 1000)),
      depositCount: depositCounts.get(row.user_id) ?? 0,
    };
  });

  return {
    items,
    total: count ?? 0,
    page: safePage,
    pageSize: safeSize,
    totalPages: Math.max(1, Math.ceil((count ?? 0) / safeSize)),
  };
}

export async function getWithdrawalContext(withdrawalId: string) {
  const admin = createAdminSupabaseClient();

  const { data: withdrawal } = await admin
    .from("withdrawals")
    .select("*")
    .eq("id", withdrawalId)
    .maybeSingle<Withdrawal>();

  if (!withdrawal) throw new ApiError("WITHDRAWAL_NOT_FOUND", "That withdrawal could not be found.", 404);

  const [profileRes, walletRes, depositsRes, earningsRes, referralsRes, fraudRes, historyRes, ledgerRes] =
    await Promise.all([
      admin.from("profiles").select("*").eq("id", withdrawal.user_id).maybeSingle<Profile>(),
      admin.from("wallets").select("*").eq("id", withdrawal.wallet_id).maybeSingle(),
      admin
        .from("deposits")
        .select("id, amount, status, created_at, completed_at")
        .eq("user_id", withdrawal.user_id)
        .order("created_at", { ascending: false })
        .limit(10),
      admin
        .from("wallet_transactions")
        .select("type, amount, status, created_at")
        .eq("user_id", withdrawal.user_id)
        .in("type", ["VIDEO_REWARD", "TASK_REWARD", "REFERRAL_REWARD"])
        .eq("status", "COMPLETED")
        .order("created_at", { ascending: false })
        .limit(10),
      admin
        .from("referrals")
        .select("id, status, created_at, qualified_at")
        .eq("referrer_id", withdrawal.user_id)
        .limit(20),
      admin
        .from("fraud_events")
        .select("*")
        .eq("user_id", withdrawal.user_id)
        .order("created_at", { ascending: false })
        .limit(10),
      admin
        .from("withdrawals")
        .select("id, amount, status, requested_at, completed_at, rejection_reason")
        .eq("user_id", withdrawal.user_id)
        .order("requested_at", { ascending: false })
        .limit(10),
      admin
        .from("wallet_transactions")
        .select("*")
        .eq("user_id", withdrawal.user_id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

  return {
    withdrawal,
    profile: profileRes.data ?? null,
    wallet: walletRes.data ?? null,
    deposits: depositsRes.data ?? [],
    earnings: earningsRes.data ?? [],
    referrals: referralsRes.data ?? [],
    fraudEvents: (fraudRes.data ?? []) as FraudEvent[],
    previousWithdrawals: historyRes.data ?? [],
    ledger: (ledgerRes.data ?? []) as WalletTransaction[],
  };
}

/* -------------------------------------------------------------------------- */
/* Users, deposits, transactions                                              */
/* -------------------------------------------------------------------------- */

export async function listAdminUsers(filters: AdminFilters): Promise<Page<Profile & { balance: number; locked: number }>> {
  const admin = createAdminSupabaseClient();
  const { safePage, safeSize, from, to } = paginate(filters.page, filters.pageSize);

  let query = admin
    .from("profiles")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filters.status && filters.status !== "ALL") query = query.eq("status", filters.status);
  if (filters.search) {
    const term = filters.search.replace(/[%,]/g, "");
    query = query.or(`full_name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%,referral_code.ilike.%${term}%`);
  }
  if (filters.from) query = query.gte("created_at", filters.from);
  if (filters.to) query = query.lte("created_at", filters.to);

  const { data, error, count } = await query;
  if (error) throw error;

  const rows = (data ?? []) as Profile[];
  const balances = new Map<string, { available: number; locked: number }>();
  if (rows.length > 0) {
    const { data: wallets } = await admin
      .from("wallets")
      .select("user_id, available_balance, locked_balance")
      .in("user_id", rows.map((r) => r.id));
    for (const w of (wallets ?? []) as {
      user_id: string;
      available_balance: number;
      locked_balance: number;
    }[]) {
      balances.set(w.user_id, { available: Number(w.available_balance), locked: Number(w.locked_balance) });
    }
  }

  return {
    items: rows.map((row) => ({
      ...row,
      balance: balances.get(row.id)?.available ?? 0,
      locked: balances.get(row.id)?.locked ?? 0,
    })),
    total: count ?? 0,
    page: safePage,
    pageSize: safeSize,
    totalPages: Math.max(1, Math.ceil((count ?? 0) / safeSize)),
  };
}

export async function listAdminDeposits(filters: AdminFilters): Promise<Page<Deposit & { user: Partial<Profile> | null }>> {
  const admin = createAdminSupabaseClient();
  const { safePage, safeSize, from, to } = paginate(filters.page, filters.pageSize);

  let query = admin
    .from("deposits")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filters.status && filters.status !== "ALL") query = query.eq("status", filters.status);
  if (filters.from) query = query.gte("created_at", filters.from);
  if (filters.to) query = query.lte("created_at", filters.to);

  const { data, error, count } = await query;
  if (error) throw error;

  const rows = (data ?? []) as Deposit[];
  const profiles = await profilesByIds(rows.map((r) => r.user_id));

  return {
    items: rows.map((row) => ({ ...row, user: profiles.get(row.user_id) ?? null })),
    total: count ?? 0,
    page: safePage,
    pageSize: safeSize,
    totalPages: Math.max(1, Math.ceil((count ?? 0) / safeSize)),
  };
}

export async function listAdminTransactions(
  filters: AdminFilters,
): Promise<Page<WalletTransaction & { user: Partial<Profile> | null }>> {
  const admin = createAdminSupabaseClient();
  const { safePage, safeSize, from, to } = paginate(filters.page, filters.pageSize);

  let query = admin
    .from("wallet_transactions")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filters.status && filters.status !== "ALL") query = query.eq("status", filters.status);

  /*
    Search matches the ledger reference AND the account behind it.

    An operator arriving from a withdrawal is holding a customer's email, not a
    ledger reference — searching only `reference` would return nothing and look
    like the ledger was empty. So a term that matches a profile (email, phone or
    name) is resolved to those user ids first, and rows are matched on either.
  */
  if (filters.search) {
    const term = filters.search.replace(/[%,()]/g, "").trim();
    const matchingUserIds = term ? await profilesMatching(term) : [];
    const clauses = [`reference.ilike.%${term}%`];
    if (matchingUserIds.length > 0) {
      clauses.push(`user_id.in.(${matchingUserIds.join(",")})`);
    }
    query = query.or(clauses.join(","));
  }

  if (filters.from) query = query.gte("created_at", filters.from);
  if (filters.to) query = query.lte("created_at", filters.to);

  const { data, error, count } = await query;
  if (error) throw error;

  const rows = (data ?? []) as WalletTransaction[];
  const profiles = await profilesByIds(rows.map((r) => r.user_id));

  return {
    items: rows.map((row) => ({ ...row, user: profiles.get(row.user_id) ?? null })),
    total: count ?? 0,
    page: safePage,
    pageSize: safeSize,
    totalPages: Math.max(1, Math.ceil((count ?? 0) / safeSize)),
  };
}

export async function listAdminFraudEvents(filters: AdminFilters): Promise<Page<FraudEvent & { user: Partial<Profile> | null }>> {
  const admin = createAdminSupabaseClient();
  const { safePage, safeSize, from, to } = paginate(filters.page, filters.pageSize);

  let query = admin
    .from("fraud_events")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filters.status && filters.status !== "ALL") query = query.eq("status", filters.status);
  if (filters.from) query = query.gte("created_at", filters.from);
  if (filters.to) query = query.lte("created_at", filters.to);

  const { data, error, count } = await query;
  if (error) throw error;

  const rows = (data ?? []) as FraudEvent[];
  const profiles = await profilesByIds(rows.map((r) => r.user_id));

  return {
    items: rows.map((row) => ({ ...row, user: profiles.get(row.user_id) ?? null })),
    total: count ?? 0,
    page: safePage,
    pageSize: safeSize,
    totalPages: Math.max(1, Math.ceil((count ?? 0) / safeSize)),
  };
}

export async function listAdminReferralCommissions(filters: AdminFilters) {
  const admin = createAdminSupabaseClient();
  const { safePage, safeSize, from, to } = paginate(filters.page, filters.pageSize);

  let query = admin
    .from("referral_commissions")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filters.status && filters.status !== "ALL") query = query.eq("status", filters.status);

  const { data, error, count } = await query;
  if (error) throw error;

  const rows = (data ?? []) as { referrer_id: string }[];
  const profiles = await profilesByIds(rows.map((row) => row.referrer_id));

  return {
    items: (data ?? []).map((row) => ({
      ...(row as Record<string, unknown>),
      user: profiles.get((row as { referrer_id: string }).referrer_id) ?? null,
    })),
    total: count ?? 0,
    page: safePage,
    pageSize: safeSize,
    totalPages: Math.max(1, Math.ceil((count ?? 0) / safeSize)),
  };
}

export async function listReconciliationAlerts(filters: AdminFilters) {
  const admin = createAdminSupabaseClient();
  const { safePage, safeSize, from, to } = paginate(filters.page, filters.pageSize);

  let query = admin
    .from("reconciliation_alerts")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filters.status && filters.status !== "ALL") query = query.eq("status", filters.status);

  const { data, error, count } = await query;
  if (error) throw error;

  return {
    items: data ?? [],
    total: count ?? 0,
    page: safePage,
    pageSize: safeSize,
    totalPages: Math.max(1, Math.ceil((count ?? 0) / safeSize)),
  };
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

export type ReportSeries = {
  date: string;
  deposits: number;
  withdrawals: number;
  rewards: number;
  referralCommissions: number;
  failedPayments: number;
  newUsers: number;
}[];

export async function getReportSeries(days = 30): Promise<ReportSeries> {
  const admin = createAdminSupabaseClient();
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  const [deposits, withdrawals, rewards, commissions, failed, users] = await Promise.all([
    admin.from("deposits").select("amount, completed_at").eq("status", "COMPLETED").gte("completed_at", since),
    admin.from("withdrawals").select("amount, completed_at").eq("status", "COMPLETED").gte("completed_at", since),
    admin
      .from("wallet_transactions")
      .select("amount, created_at")
      .in("type", ["VIDEO_REWARD", "TASK_REWARD", "REFERRAL_REWARD"])
      .eq("status", "COMPLETED")
      .gte("created_at", since),
    admin
      .from("referral_commissions")
      .select("amount, created_at")
      .eq("status", "CREDITED")
      .gte("created_at", since),
    admin
      .from("deposits")
      .select("id, created_at")
      .in("status", ["FAILED", "REJECTED", "CANCELLED"])
      .gte("created_at", since),
    admin.from("profiles").select("id, created_at").gte("created_at", since),
  ]);

  const buckets = new Map<string, ReportSeries[number]>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    buckets.set(date, {
      date,
      deposits: 0,
      withdrawals: 0,
      rewards: 0,
      referralCommissions: 0,
      failedPayments: 0,
      newUsers: 0,
    });
  }

  const add = (rows: unknown, key: keyof ReportSeries[number], dateKey: string, field: string) => {
    for (const row of (rows as Record<string, unknown>[]) ?? []) {
      const stamp = row[dateKey];
      if (typeof stamp !== "string") continue;
      const bucket = buckets.get(stamp.slice(0, 10));
      if (!bucket) continue;
      if (key === "failedPayments" || key === "newUsers") {
        (bucket[key] as number) += 1;
      } else {
        (bucket[key] as number) += Number(row[field] ?? 0);
      }
    }
  };

  add(deposits.data, "deposits", "completed_at", "amount");
  add(withdrawals.data, "withdrawals", "completed_at", "amount");
  add(rewards.data, "rewards", "created_at", "amount");
  add(commissions.data, "referralCommissions", "created_at", "amount");
  add(failed.data, "failedPayments", "created_at", "id");
  add(users.data, "newUsers", "created_at", "id");

  return Array.from(buckets.values());
}

export async function getReportTotals(days = 30) {
  const series = await getReportSeries(days);
  const sum = (key: keyof ReportSeries[number]) =>
    series.reduce((acc, row) => acc + Number(row[key] ?? 0), 0);

  return {
    days,
    deposits: sum("deposits"),
    withdrawals: sum("withdrawals"),
    rewards: sum("rewards"),
    referralCommissions: sum("referralCommissions"),
    failedPayments: sum("failedPayments"),
    newUsers: sum("newUsers"),
    netActivity: sum("deposits") - sum("withdrawals"),
    campaignSpend: await campaignSpend(),
  };
}

async function campaignSpend() {
  const admin = createAdminSupabaseClient();
  const { data } = await admin.from("video_campaigns").select("spent");
  return (data ?? []).reduce((acc, row) => acc + Number((row as { spent: number }).spent), 0);
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                  */
/* -------------------------------------------------------------------------- */

export async function setUserStatus(input: {
  adminId: string;
  userId: string;
  status: string;
  reason: string;
  ipHash: string | null;
  userAgent: string | null;
}) {
  const admin = createAdminSupabaseClient();

  const { error } = await admin
    .from("profiles")
    .update({ status: input.status })
    .eq("id", input.userId);
  if (error) throw error;

  await admin.rpc("write_audit", {
    p_admin_id: input.adminId,
    p_user_id: input.userId,
    p_action: `USER_STATUS_${input.status}`,
    p_entity: "profile",
    p_entity_id: input.userId,
    p_description: `Set account status to ${input.status}: ${input.reason}`,
    p_metadata: { status: input.status, reason: input.reason },
    p_ip_hash: input.ipHash,
    p_user_agent: input.userAgent,
  });

  await admin.rpc("notify_user", {
    p_user_id: input.userId,
    p_type: "ACCOUNT_STATUS_CHANGED",
    p_title: "Account status updated",
    p_message: `Your account status is now ${input.status.toLowerCase()}. ${
      input.status === "ACTIVE" ? "You can continue earning and withdrawing." : "Please contact support for details."
    }`,
    p_severity: input.status === "ACTIVE" ? "SUCCESS" : "WARNING",
    p_link: "/dashboard/profile",
    p_metadata: { status: input.status },
  });
}

export async function setKycStatus(input: {
  adminId: string;
  userId: string;
  kycStatus: string;
  note?: string;
  ipHash: string | null;
  userAgent: string | null;
}) {
  const admin = createAdminSupabaseClient();

  const { error } = await admin
    .from("profiles")
    .update({ kyc_status: input.kycStatus })
    .eq("id", input.userId);
  if (error) throw error;

  await admin.rpc("write_audit", {
    p_admin_id: input.adminId,
    p_user_id: input.userId,
    p_action: "KYC_STATUS_UPDATED",
    p_entity: "profile",
    p_entity_id: input.userId,
    p_description: `Set KYC status to ${input.kycStatus}`,
    p_metadata: { kycStatus: input.kycStatus, note: input.note ?? null },
    p_ip_hash: input.ipHash,
    p_user_agent: input.userAgent,
  });

  if (input.kycStatus === "VERIFIED") {
    await admin.rpc("referral_qualify", {
      p_referred_user_id: input.userId,
      p_event: "KYC_VERIFIED",
    });
  }
}

export async function reviewFraudEvent(input: {
  adminId: string;
  eventId: string;
  status: string;
  note?: string;
  riskStatus?: string;
  ipHash: string | null;
  userAgent: string | null;
}) {
  const admin = createAdminSupabaseClient();

  const { data: event, error } = await admin
    .from("fraud_events")
    .update({
      status: input.status,
      reviewed_by: input.adminId,
      reviewed_at: new Date().toISOString(),
      review_note: input.note ?? null,
    })
    .eq("id", input.eventId)
    .select("user_id")
    .single<{ user_id: string }>();
  if (error) throw error;

  // A risk-status change is always explicit and always audited. Signals alone
  // never restrict an account.
  if (input.riskStatus) {
    await admin.from("profiles").update({ risk_status: input.riskStatus }).eq("id", event.user_id);
  }

  await admin.rpc("write_audit", {
    p_admin_id: input.adminId,
    p_user_id: event.user_id,
    p_action: "FRAUD_EVENT_REVIEWED",
    p_entity: "fraud_event",
    p_entity_id: input.eventId,
    p_description: `Marked fraud event ${input.status}${input.riskStatus ? ` and set risk status to ${input.riskStatus}` : ""}`,
    p_metadata: { status: input.status, note: input.note ?? null, riskStatus: input.riskStatus ?? null },
    p_ip_hash: input.ipHash,
    p_user_agent: input.userAgent,
  });
}

export async function upsertVideo(input: {
  adminId: string;
  payload: Record<string, unknown>;
  videoId?: string;
}) {
  const admin = createAdminSupabaseClient();

  const record = {
    campaign_id: (input.payload.campaignId as string | null) ?? null,
    title: input.payload.title,
    description: input.payload.description ?? null,
    video_url: input.payload.videoUrl,
    thumbnail_url: input.payload.thumbnailUrl ?? null,
    duration_seconds: input.payload.durationSeconds,
    required_watch_seconds: input.payload.requiredWatchSeconds,
    reward_amount: input.payload.rewardAmount,
    currency: input.payload.currency,
    daily_limit: input.payload.dailyLimit,
    total_view_limit: input.payload.totalViewLimit ?? null,
    status: input.payload.status,
    created_by: input.adminId,
  };

  const query = input.videoId
    ? admin.from("videos").update(record).eq("id", input.videoId).select("id, title, status").single()
    : admin.from("videos").insert(record).select("id, title, status").single();

  const { data, error } = await query;
  if (error) throw error;

  await admin.rpc("write_audit", {
    p_admin_id: input.adminId,
    p_user_id: null,
    p_action: input.videoId ? "VIDEO_UPDATED" : "VIDEO_CREATED",
    p_entity: "video",
    p_entity_id: data.id,
    p_description: `${input.videoId ? "Updated" : "Created"} video "${data.title}"`,
    p_metadata: { status: data.status, reward: record.reward_amount },
    p_ip_hash: null,
    p_user_agent: null,
  });

  return data;
}

export async function upsertCampaign(input: { adminId: string; payload: Record<string, unknown>; campaignId?: string }) {
  const admin = createAdminSupabaseClient();

  const record = {
    name: input.payload.name,
    description: input.payload.description ?? null,
    advertiser: input.payload.advertiser ?? null,
    budget: input.payload.budget,
    reward_per_view: input.payload.rewardPerView,
    max_views: input.payload.maxViews ?? null,
    start_at: input.payload.startAt ?? null,
    end_at: input.payload.endAt ?? null,
    status: input.payload.status,
    created_by: input.adminId,
  };

  const query = input.campaignId
    ? admin.from("video_campaigns").update(record).eq("id", input.campaignId).select("id, name, status").single()
    : admin.from("video_campaigns").insert(record).select("id, name, status").single();

  const { data, error } = await query;
  if (error) throw error;

  await admin.rpc("write_audit", {
    p_admin_id: input.adminId,
    p_user_id: null,
    p_action: input.campaignId ? "CAMPAIGN_UPDATED" : "CAMPAIGN_CREATED",
    p_entity: "video_campaign",
    p_entity_id: data.id,
    p_description: `${input.campaignId ? "Updated" : "Created"} campaign "${data.name}"`,
    p_metadata: { status: data.status, budget: record.budget },
    p_ip_hash: null,
    p_user_agent: null,
  });

  return data;
}

export async function updateSettings(input: {
  adminId: string;
  updates: { key: string; value: unknown }[];
  ipHash: string | null;
  userAgent: string | null;
}) {
  const admin = createAdminSupabaseClient();

  for (const update of input.updates) {
    const { error } = await admin
      .from("system_settings")
      .upsert(
        {
          key: update.key,
          value: update.value,
          updated_by: input.adminId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" },
      );
    if (error) {
      logger.error("settings_update_failed", { key: update.key, error: error.message });
      throw new ApiError("SETTINGS_UPDATE_FAILED", `Could not update ${update.key}.`, 500);
    }
  }

  await admin.rpc("write_audit", {
    p_admin_id: input.adminId,
    p_user_id: null,
    p_action: "SETTINGS_UPDATED",
    p_entity: "system_settings",
    p_entity_id: null,
    p_description: `Updated ${input.updates.length} setting(s)`,
    p_metadata: { keys: input.updates.map((u) => u.key) },
    p_ip_hash: input.ipHash,
    p_user_agent: input.userAgent,
  });
}

export async function listAuditLogs(filters: AdminFilters) {
  const admin = createAdminSupabaseClient();
  const { safePage, safeSize, from, to } = paginate(filters.page, filters.pageSize);

  let query = admin
    .from("audit_logs")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filters.search) query = query.or(`action.ilike.%${filters.search.replace(/[%,]/g, "")}%`);

  const { data, error, count } = await query;
  if (error) throw error;

  return {
    items: data ?? [],
    total: count ?? 0,
    page: safePage,
    pageSize: safeSize,
    totalPages: Math.max(1, Math.ceil((count ?? 0) / safeSize)),
  };
}

/* -------------------------------------------------------------------------- */
/* CSV export                                                                 */
/* -------------------------------------------------------------------------- */

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return "no records\n";
  const keys = columns ?? Object.keys(rows[0]);
  const header = keys.join(",");
  const body = rows
    .map((row) => keys.map((key) => csvEscape(row[key])).join(","))
    .join("\n");
  return `${header}\n${body}\n`;
}

export const EXPORT_COLUMNS: Record<string, string[]> = {
  users: ["id", "full_name", "email", "phone", "country", "currency", "status", "kyc_status", "role", "risk_status", "referral_code", "created_at"],
  deposits: ["id", "user_id", "amount", "currency", "phone", "status", "merchant_reference", "provider_transaction_id", "created_at", "completed_at"],
  withdrawals: ["id", "user_id", "amount", "fee", "net_amount", "currency", "phone", "status", "admin_id", "provider_transaction_id", "provider_reference", "requested_at", "completed_at", "rejection_reason"],
  transactions: ["id", "user_id", "type", "amount", "currency", "status", "direction", "reference", "external_reference", "balance_after", "created_at", "completed_at"],
  video_rewards: ["id", "user_id", "video_id", "status", "watched_seconds", "reward_amount", "reward_reference", "rewarded_at"],
  referral_commissions: ["id", "referrer_id", "referred_user_id", "amount", "currency", "level", "rate", "base_amount", "status", "qualifying_event", "created_at", "credited_at"],
};
