import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { publicEnv } from "@/lib/env";

/**
 * Referral reads.
 *
 * A referral relationship is only ever created by public.ensure_profile() from
 * a validated referral code, never by the client. Commissions are only ever
 * created by public.referral_credit(), which is idempotent per event.
 */

export type ReferralRow = {
  id: string;
  referredUserId: string;
  maskedName: string;
  status: "PENDING" | "QUALIFIED" | "REJECTED";
  qualifyingEvent: string | null;
  createdAt: string;
  qualifiedAt: string | null;
  commissionTotal: number;
};

export type ReferralStats = {
  totalReferrals: number;
  activeReferrals: number;
  qualifyingReferrals: number;
  pendingReferrals: number;
  totalEarned: number;
  pendingCommissions: number;
  paidCommissions: number;
  level1Rate: number;
  level2Rate: number;
  signupBonus: number;
  enabled: boolean;
  qualifyingEvent: string;
  commissionOnDeposit: boolean;
};

export function referralLink(code: string): string {
  const base = publicEnv.appUrl || "";
  return `${base.replace(/\/+$/, "")}/register?ref=${code}`;
}

/** Referred users are shown with a masked name — never another user's details. */
function maskName(fullName: string | null | undefined, fallbackEmail?: string | null): string {
  if (fullName && fullName.trim()) {
    const parts = fullName.trim().split(/\s+/);
    const first = parts[0] ?? "";
    const lastInitial = parts[1]?.[0] ? `${parts[1][0]}.` : "";
    return `${first} ${lastInitial}`.trim();
  }
  if (fallbackEmail) {
    const [local] = fallbackEmail.split("@");
    return `${local.slice(0, 3)}***`;
  }
  return "Referred user";
}

export async function listReferrals(referrerId: string): Promise<ReferralRow[]> {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from("referrals")
    .select("*")
    .eq("referrer_id", referrerId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;
  const referrals = (data ?? []) as {
    id: string;
    referred_user_id: string;
    status: ReferralRow["status"];
    qualifying_event: string | null;
    created_at: string;
    qualified_at: string | null;
  }[];

  if (referrals.length === 0) return [];

  const admin = createAdminSupabaseClient();
  const ids = referrals.map((r) => r.referred_user_id);

  const [profilesRes, commissionsRes] = await Promise.all([
    admin.from("profiles").select("id, full_name, email").in("id", ids),
    supabase
      .from("referral_commissions")
      .select("referred_user_id, amount, status")
      .eq("referrer_id", referrerId)
      .in("referred_user_id", ids),
  ]);

  const profiles = new Map(
    ((profilesRes.data ?? []) as { id: string; full_name: string; email: string }[]).map((p) => [p.id, p]),
  );

  const totals = new Map<string, number>();
  for (const row of (commissionsRes.data ?? []) as {
    referred_user_id: string;
    amount: number;
    status: string;
  }[]) {
    if (row.status !== "CREDITED") continue;
    totals.set(row.referred_user_id, (totals.get(row.referred_user_id) ?? 0) + Number(row.amount));
  }

  return referrals.map((r) => {
    const profile = profiles.get(r.referred_user_id);
    return {
      id: r.id,
      referredUserId: r.referred_user_id,
      maskedName: maskName(profile?.full_name, profile?.email),
      status: r.status,
      qualifyingEvent: r.qualifying_event,
      createdAt: r.created_at,
      qualifiedAt: r.qualified_at,
      commissionTotal: totals.get(r.referred_user_id) ?? 0,
    };
  });
}

export async function getReferralStats(referrerId: string): Promise<ReferralStats> {
  const admin = createAdminSupabaseClient();

  const [referralsRes, commissionsRes, settingsRes] = await Promise.all([
    admin.from("referrals").select("status").eq("referrer_id", referrerId),
    admin
      .from("referral_commissions")
      .select("amount, status")
      .eq("referrer_id", referrerId),
    admin
      .from("system_settings")
      .select("key, value")
      .in("key", [
        "referrals.enabled",
        "referrals.qualifying_event",
        "referrals.level1_rate",
        "referrals.level2_rate",
        "referrals.signup_bonus",
        "referrals.commission_on_deposit",
      ]),
  ]);

  const settings = new Map(
    (settingsRes.data ?? []).map((row) => [
      (row as { key: string }).key,
      (row as { value: unknown }).value,
    ]),
  );

  const referrals = (referralsRes.data ?? []) as { status: string }[];
  const commissions = (commissionsRes.data ?? []) as { amount: number; status: string }[];

  const sumBy = (status: string) =>
    commissions.filter((c) => c.status === status).reduce((acc, c) => acc + Number(c.amount), 0);

  const rate = (key: string, fallback: number) => {
    const raw = settings.get(key);
    const parsed = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    totalReferrals: referrals.length,
    activeReferrals: referrals.filter((r) => r.status !== "REJECTED").length,
    qualifyingReferrals: referrals.filter((r) => r.status === "QUALIFIED").length,
    pendingReferrals: referrals.filter((r) => r.status === "PENDING").length,
    totalEarned: sumBy("CREDITED"),
    pendingCommissions: sumBy("PENDING"),
    paidCommissions: sumBy("CREDITED"),
    level1Rate: rate("referrals.level1_rate", 0.05),
    level2Rate: rate("referrals.level2_rate", 0),
    signupBonus: rate("referrals.signup_bonus", 0),
    enabled: settings.get("referrals.enabled") !== false,
    qualifyingEvent: String(settings.get("referrals.qualifying_event") ?? "VERIFIED_REGISTRATION"),
    commissionOnDeposit: settings.get("referrals.commission_on_deposit") !== false,
  };
}

export const QUALIFYING_EVENT_COPY: Record<string, string> = {
  VERIFIED_REGISTRATION: "They confirm their email address.",
  KYC_VERIFIED: "Their identity verification is approved.",
  ELIGIBLE_DEPOSIT: "They complete their first eligible deposit.",
  QUALIFYING_TASK: "They complete a qualifying task.",
};

export function qualifyingEventCopy(event: string): string {
  return QUALIFYING_EVENT_COPY[event] ?? "They complete the configured qualifying activity.";
}
