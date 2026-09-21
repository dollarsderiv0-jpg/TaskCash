import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { Wallet, WalletTransaction, Withdrawal } from "@/lib/types";

/**
 * Wallet reads.
 *
 * The balance itself is never computed in TypeScript — it is read from the
 * `wallet_totals` view, whose totals are aggregated from the immutable ledger,
 * and `wallets.available_balance` / `locked_balance` are only ever written by
 * public.wallet_post().
 */

export type WalletOverview = {
  wallet: Wallet;
  totalDeposited: number;
  totalWithdrawn: number;
  totalEarned: number;
  pendingWithdrawal: number;
  balance: number;
};

export async function getWalletOverview(userId: string): Promise<WalletOverview | null> {
  const supabase = await createServerSupabaseClient();

  const { data: wallet, error } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle<Wallet>();

  if (error || !wallet) return null;

  const { data: totals } = await supabase
    .from("wallet_totals")
    .select("total_deposited, total_withdrawn, total_earned, total_balance")
    .eq("user_id", userId)
    .maybeSingle<{
      total_deposited: number;
      total_withdrawn: number;
      total_earned: number;
      total_balance: number;
    }>();

  const { data: pending } = await supabase
    .from("withdrawals")
    .select("amount, status")
    .eq("user_id", userId)
    .in("status", ["PENDING_ADMIN_APPROVAL", "APPROVED", "PROCESSING"]);

  const pendingWithdrawal = (pending ?? []).reduce(
    (sum, row) => sum + Number((row as { amount: number }).amount),
    0,
  );

  return {
    wallet,
    totalDeposited: Number(totals?.total_deposited ?? 0),
    totalWithdrawn: Number(totals?.total_withdrawn ?? 0),
    totalEarned: Number(totals?.total_earned ?? 0),
    pendingWithdrawal,
    balance: Number(wallet.available_balance) + Number(wallet.locked_balance),
  };
}

export type TransactionFilters = {
  page?: number;
  pageSize?: number;
  type?: string | null;
  /**
   * Several transaction types in one filter, e.g. the "Earned" tab which groups
   * video, task and referral rewards. Filtering happens in the database rather
   * than in the browser, so the count and the pagination stay honest — a client
   * side filter would only ever see the page it was handed.
   */
  types?: string[] | null;
  status?: string | null;
  from?: string | null;
  to?: string | null;
};

export async function listWalletTransactions(userId: string, filters: TransactionFilters = {}) {
  const supabase = await createServerSupabaseClient();
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));
  const from = (page - 1) * pageSize;

  let query = supabase
    .from("wallet_transactions")
    .select("*", { count: "exact" })
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);

  if (filters.type) query = query.eq("type", filters.type);
  if (filters.types && filters.types.length > 0) query = query.in("type", filters.types);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.from) query = query.gte("created_at", filters.from);
  if (filters.to) query = query.lte("created_at", filters.to);

  const { data, error, count } = await query;
  if (error) throw error;

  return {
    items: (data ?? []) as WalletTransaction[],
    total: count ?? 0,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil((count ?? 0) / pageSize)),
  };
}

/** Earnings aggregated for the dashboard cards and charts. */
export async function getEarningsSummary(userId: string) {
  const supabase = await createServerSupabaseClient();

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const earningTypes = ["VIDEO_REWARD", "TASK_REWARD", "REFERRAL_REWARD"];

  const [todayRes, monthRes, videosRes, referralRes, seriesRes] = await Promise.all([
    supabase
      .from("wallet_transactions")
      .select("amount")
      .eq("user_id", userId)
      .in("type", earningTypes)
      .eq("status", "COMPLETED")
      .gte("created_at", startOfToday.toISOString()),
    supabase
      .from("wallet_transactions")
      .select("amount")
      .eq("user_id", userId)
      .in("type", earningTypes)
      .eq("status", "COMPLETED")
      .gte("created_at", startOfMonth.toISOString()),
    supabase
      .from("video_watch_sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "REWARDED"),
    supabase
      .from("referral_commissions")
      .select("amount")
      .eq("referrer_id", userId)
      .eq("status", "CREDITED"),
    supabase
      .from("wallet_transactions")
      .select("amount, created_at, type")
      .eq("user_id", userId)
      .in("type", earningTypes)
      .eq("status", "COMPLETED")
      .gte("created_at", new Date(Date.now() - 29 * 24 * 3600 * 1000).toISOString())
      .order("created_at", { ascending: true }),
  ]);

  const sum = (rows: { amount: number }[] | null) =>
    (rows ?? []).reduce((acc, row) => acc + Number(row.amount), 0);

  // Bucket the last 30 days so the chart has a stable x-axis.
  const buckets = new Map<string, number>();
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const row of (seriesRes.data ?? []) as { amount: number; created_at: string }[]) {
    const key = row.created_at.slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + Number(row.amount));
  }

  return {
    todayEarnings: sum(todayRes.data as { amount: number }[] | null),
    monthEarnings: sum(monthRes.data as { amount: number }[] | null),
    referralEarnings: sum(referralRes.data as { amount: number }[] | null),
    videosCompleted: videosRes.count ?? 0,
    earningsSeries: Array.from(buckets.entries()).map(([date, amount]) => ({ date, amount })),
  };
}

/** Aggregate platform figures for the admin dashboard. */
export async function getAdminDashboardStats() {
  const admin = createAdminSupabaseClient();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [
    usersRes,
    activeUsersRes,
    newUsersRes,
    depositsTodayRes,
    pendingDepositsRes,
    pendingWithdrawalsRes,
    completedWithdrawalsRes,
    rewardsTodayRes,
    referralRes,
    campaignSpendRes,
    fraudReviewRes,
    usersInReviewRes,
  ] = await Promise.all([
    admin.from("profiles").select("id", { count: "exact", head: true }),
    admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .gte("last_login_at", new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()),
    admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .gte("created_at", startOfToday.toISOString()),
    admin
      .from("deposits")
      .select("amount")
      .eq("status", "COMPLETED")
      .gte("completed_at", startOfToday.toISOString()),
    admin.from("deposits").select("id", { count: "exact", head: true }).eq("status", "PENDING"),
    admin
      .from("withdrawals")
      .select("id", { count: "exact", head: true })
      .in("status", ["PENDING_ADMIN_APPROVAL", "APPROVED", "PROCESSING"]),
    admin
      .from("withdrawals")
      .select("amount")
      .eq("status", "COMPLETED")
      .gte("completed_at", startOfToday.toISOString()),
    admin
      .from("wallet_transactions")
      .select("amount")
      .in("type", ["VIDEO_REWARD", "TASK_REWARD", "REFERRAL_REWARD"])
      .eq("status", "COMPLETED")
      .gte("created_at", startOfToday.toISOString()),
    admin
      .from("referral_commissions")
      .select("amount")
      .eq("status", "CREDITED")
      .gte("created_at", startOfToday.toISOString()),
    admin.from("video_campaigns").select("budget, spent"),
    // Things that need a person to look at them. Surfaced on the overview so
    // they are not discovered only by remembering to open the fraud queue.
    admin
      .from("fraud_events")
      .select("id", { count: "exact", head: true })
      .in("status", ["OPEN", "REVIEWING"]),
    admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .in("risk_status", ["REVIEW", "RESTRICTED"]),
  ]);

  const sum = (rows: { amount: number }[] | null | undefined) =>
    (rows ?? []).reduce((acc, row) => acc + Number(row.amount), 0);

  const campaigns = (campaignSpendRes.data ?? []) as { budget: number; spent: number }[];

  return {
    totalUsers: usersRes.count ?? 0,
    activeUsers: activeUsersRes.count ?? 0,
    newUsersToday: newUsersRes.count ?? 0,
    depositsToday: sum(depositsTodayRes.data as { amount: number }[] | null),
    pendingDeposits: pendingDepositsRes.count ?? 0,
    pendingWithdrawals: pendingWithdrawalsRes.count ?? 0,
    completedWithdrawalsToday: sum(completedWithdrawalsRes.data as { amount: number }[] | null),
    rewardsToday: sum(rewardsTodayRes.data as { amount: number }[] | null),
    referralCommissionsToday: sum(referralRes.data as { amount: number }[] | null),
    campaignSpend: campaigns.reduce((acc, c) => acc + Number(c.spent), 0),
    campaignBudget: campaigns.reduce((acc, c) => acc + Number(c.budget), 0),
    fraudAlerts: fraudReviewRes.count ?? 0,
    usersNeedingReview: usersInReviewRes.count ?? 0,
  };
}

/** Pending liability: money users are owed but which has not been paid out. */
export async function getPendingLiabilities() {
  const admin = createAdminSupabaseClient();

  const [availableRes, lockedRes] = await Promise.all([
    admin.from("wallets").select("available_balance, locked_balance, currency"),
    admin
      .from("withdrawals")
      .select("id", { count: "exact", head: true })
      .in("status", ["PENDING_ADMIN_APPROVAL", "APPROVED", "PROCESSING"]),
  ]);

  const byCurrency = new Map<string, { available: number; locked: number }>();
  for (const row of (availableRes.data ?? []) as {
    available_balance: number;
    locked_balance: number;
    currency: string;
  }[]) {
    const entry = byCurrency.get(row.currency) ?? { available: 0, locked: 0 };
    entry.available += Number(row.available_balance);
    entry.locked += Number(row.locked_balance);
    byCurrency.set(row.currency, entry);
  }

  return {
    byCurrency: Array.from(byCurrency.entries()).map(([currency, v]) => ({ currency, ...v })),
    pendingWithdrawalCount: lockedRes.count ?? 0,
  };
}

export async function listUserWithdrawals(userId: string, limit = 20): Promise<Withdrawal[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("withdrawals")
    .select("*")
    .eq("user_id", userId)
    .order("requested_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as Withdrawal[];
}
