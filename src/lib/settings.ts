import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { describeError, logger } from "@/lib/logger";

/**
 * Server-side access to the admin-configurable business rules.
 *
 * These values drive the UI (limits, legal contact details). Rules that affect
 * money are *also* re-read inside the Postgres money functions, so the database
 * stays authoritative even if this cache is momentarily stale.
 *
 * Platform identity fields ship empty on purpose: the site must never invent a
 * legal entity, licence or registration number.
 */

export type SettingsMap = Record<string, unknown>;

export type PlatformIdentity = {
  legalName: string;
  registrationDetails: string;
  businessAddress: string;
  supportEmail: string;
  supportPhone: string;
  privacyContact: string;
  dataProtectionNote: string;
  paymentProviderDetails: string;
};

export type PublicSettings = {
  referralsEnabled: boolean;
  referralQualifyingEvent: string;
  level1Rate: number;
  level2Rate: number;
  signupBonus: number;
  minDeposit: number;
  maxDeposit: number;
  minWithdrawal: number;
  maxWithdrawal: number;
  withdrawalFee: number;
  withdrawalsDailyLimit: number;
  requireVerifiedKyc: boolean;
  minAccountAgeHours: number;
  maxPendingWithdrawals: number;
  cooldownSeconds: number;
  dailyRewardCap: number;
  identity: PlatformIdentity;
};

const EMPTY = "Not configured — see Settings → Platform details";

async function readSettings(): Promise<SettingsMap> {
  try {
    const admin = createAdminSupabaseClient();
    const { data, error } = await admin.from("system_settings").select("key, value");
    if (error) throw error;
    const map: SettingsMap = {};
    for (const row of data ?? []) {
      map[(row as { key: string }).key] = (row as { value: unknown }).value;
    }
    return map;
  } catch (error) {
    logger.error("settings_read_failed", { error: describeError(error) });
    return {};
  }
}

function num(map: SettingsMap, key: string, fallback: number): number {
  const raw = map[key];
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function bool(map: SettingsMap, key: string, fallback: boolean): boolean {
  const raw = map[key];
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw === "true";
  return fallback;
}

function text(map: SettingsMap, key: string, fallback = ""): string {
  const raw = map[key];
  if (typeof raw === "string") return raw.trim();
  if (raw === null || raw === undefined) return fallback;
  return String(raw);
}

export async function getPublicSettings(): Promise<PublicSettings> {
  const map = await readSettings();

  return {
    referralsEnabled: bool(map, "referrals.enabled", true),
    referralQualifyingEvent: text(map, "referrals.qualifying_event", "VERIFIED_REGISTRATION"),
    level1Rate: num(map, "referrals.level1_rate", 0.05),
    level2Rate: num(map, "referrals.level2_rate", 0),
    signupBonus: num(map, "referrals.signup_bonus", 0),
    minDeposit: num(map, "deposits.min_amount", 10),
    maxDeposit: num(map, "deposits.max_amount", 150000),
    minWithdrawal: num(map, "withdrawals.min_amount", 100),
    maxWithdrawal: num(map, "withdrawals.max_amount", 100000),
    withdrawalFee: num(map, "withdrawals.fee", 0),
    withdrawalsDailyLimit: num(map, "withdrawals.daily_limit", 50000),
    requireVerifiedKyc: bool(map, "withdrawals.require_verified_kyc", false),
    minAccountAgeHours: num(map, "withdrawals.min_account_age_hours", 0),
    maxPendingWithdrawals: num(map, "withdrawals.max_pending_requests", 1),
    cooldownSeconds: num(map, "rewards.cooldown_seconds", 0),
    dailyRewardCap: num(map, "rewards.max_daily_rewarded_sessions", 200),
    identity: {
      legalName: text(map, "platform.legal_name") || EMPTY,
      registrationDetails: text(map, "platform.registration_details") || EMPTY,
      businessAddress: text(map, "platform.business_address") || EMPTY,
      supportEmail: text(map, "platform.support_email") || EMPTY,
      supportPhone: text(map, "platform.support_phone") || EMPTY,
      privacyContact: text(map, "platform.privacy_contact") || EMPTY,
      dataProtectionNote: text(map, "platform.data_protection_note") || EMPTY,
      paymentProviderDetails: text(map, "platform.payment_provider_details") || EMPTY,
    },
  };
}

export async function getSetting(key: string): Promise<unknown> {
  const map = await readSettings();
  return map[key] ?? null;
}

/** Full settings list for the admin settings screen. */
export async function listSettings() {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from("system_settings")
    .select("key, value, type, category, description, is_public, updated_at")
    .order("category", { ascending: true })
    .order("key", { ascending: true });

  if (error) throw error;
  return data ?? [];
}
