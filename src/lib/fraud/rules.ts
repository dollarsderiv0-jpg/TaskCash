import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import type { RiskStatus } from "@/lib/types";

/**
 * Anti-fraud layer.
 *
 * Design principles, deliberately conservative:
 *  - A single weak signal never bans anyone. Signals accumulate into a score,
 *    and a score only ever moves a user into the *review queue*.
 *  - Restriction and suspension are explicit administrator actions.
 *  - Every signal is recorded as a fraud_event so an operator can see why.
 */

export type RiskSignal = {
  type: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  score: number;
  details: Record<string, unknown>;
};

export type RiskAssessment = {
  score: number;
  level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  signals: RiskSignal[];
  recommendedStatus: RiskStatus;
};

const LEVEL_SCORE = { LOW: 5, MEDIUM: 15, HIGH: 30, CRITICAL: 50 } as const;

export function scoreFor(severity: RiskSignal["severity"]) {
  return LEVEL_SCORE[severity];
}

async function thresholds() {
  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("system_settings")
    .select("key, value")
    .in("key", [
      "fraud.review_score_threshold",
      "fraud.restrict_score_threshold",
      "fraud.suspend_score_threshold",
    ]);

  const map: Record<string, number> = {};
  for (const row of data ?? []) {
    const r = row as { key: string; value: unknown };
    const parsed = typeof r.value === "number" ? r.value : Number(r.value);
    if (Number.isFinite(parsed)) map[r.key] = parsed;
  }

  return {
    review: map["fraud.review_score_threshold"] ?? 40,
    restrict: map["fraud.restrict_score_threshold"] ?? 70,
    suspend: map["fraud.suspend_score_threshold"] ?? 90,
  };
}

export function levelFromScore(score: number, t: { review: number; restrict: number; suspend: number }): RiskAssessment["level"] {
  if (score >= t.suspend) return "CRITICAL";
  if (score >= t.restrict) return "HIGH";
  if (score >= t.review) return "MEDIUM";
  return "LOW";
}

/**
 * Assesses a withdrawal request across the signals that matter for payout
 * fraud: account age, deposit-to-earning ratio, referral concentration,
 * velocity and open fraud events.
 */
export async function assessWithdrawal(input: {
  userId: string;
  amount: number;
  currency: string;
  accountCreatedAt: string;
  riskScore: number;
}): Promise<RiskAssessment> {
  const admin = createAdminSupabaseClient();
  const signals: RiskSignal[] = [];

  const [depositsRes, earnedRes, referralsRes, openEventsRes, recentWithdrawalsRes, deviceRes] =
    await Promise.all([
      admin
        .from("deposits")
        .select("amount, status")
        .eq("user_id", input.userId)
        .eq("status", "COMPLETED"),
      admin
        .from("wallet_transactions")
        .select("type, amount")
        .eq("user_id", input.userId)
        .in("type", ["VIDEO_REWARD", "TASK_REWARD", "REFERRAL_REWARD"])
        .eq("status", "COMPLETED"),
      admin
        .from("referral_commissions")
        .select("amount")
        .eq("referrer_id", input.userId)
        .eq("status", "CREDITED"),
      admin
        .from("fraud_events")
        .select("severity, event_type")
        .eq("user_id", input.userId)
        .in("status", ["OPEN", "REVIEWING"]),
      admin
        .from("withdrawals")
        .select("amount, status, requested_at")
        .eq("user_id", input.userId)
        .gte("requested_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
      admin
        .from("video_watch_sessions")
        .select("device_hash")
        .eq("user_id", input.userId)
        .not("device_hash", "is", null)
        .limit(50),
    ]);

  const totalDeposited = (depositsRes.data ?? []).reduce(
    (sum, d) => sum + Number((d as { amount: number }).amount),
    0,
  );
  const totalEarned = (earnedRes.data ?? []).reduce(
    (sum, d) => sum + Number((d as { amount: number }).amount),
    0,
  );
  const totalReferral = (referralsRes.data ?? []).reduce(
    (sum, d) => sum + Number((d as { amount: number }).amount),
    0,
  );
  const openEvents = (openEventsRes.data ?? []) as { severity: string; event_type: string }[];
  const recentWithdrawals = (recentWithdrawalsRes.data ?? []) as { amount: number; status: string }[];
  const devices = new Set(
    (deviceRes.data ?? [])
      .map((d) => (d as { device_hash: string | null }).device_hash)
      .filter(Boolean),
  );

  const accountAgeHours = (Date.now() - new Date(input.accountCreatedAt).getTime()) / 3_600_000;

  // 1. Very new account requesting a large payout.
  if (accountAgeHours < 24 && input.amount > totalDeposited * 0.5 && input.amount > 1000) {
    signals.push({
      type: "NEW_ACCOUNT_HIGH_VALUE_WITHDRAWAL",
      severity: "MEDIUM",
      score: scoreFor("MEDIUM"),
      details: { accountAgeHours: Math.round(accountAgeHours), amount: input.amount },
    });
  }

  // 2. Earning vastly more than was ever deposited — a classic mule pattern.
  if (input.amount > 0 && totalDeposited === 0 && totalEarned > 0 && input.amount > 500) {
    signals.push({
      type: "NO_DEPOSIT_HIGH_WITHDRAWAL",
      severity: "LOW",
      score: scoreFor("LOW"),
      details: { amount: input.amount, totalEarned },
    });
  }

  // 3. Nearly all balance came from referrals rather than own activity.
  if (totalReferral > 0 && totalReferral > totalEarned * 0.8 && totalReferral > 1000) {
    signals.push({
      type: "REFERRAL_HEAVY_EARNINGS",
      severity: "MEDIUM",
      score: scoreFor("MEDIUM"),
      details: { totalReferral, totalEarned },
    });
  }

  // 4. Many distinct devices on one account is legitimate for some users,
  //    so this is only a soft signal.
  if (devices.size >= 6) {
    signals.push({
      type: "MANY_DEVICES",
      severity: "LOW",
      score: scoreFor("LOW"),
      details: { deviceCount: devices.size },
    });
  }

  // 5. Withdrawal velocity.
  const recentTotal = recentWithdrawals.reduce((s, w) => s + Number(w.amount), 0);
  if (recentWithdrawals.length >= 3 && recentTotal > 5000) {
    signals.push({
      type: "WITHDRAWAL_VELOCITY",
      severity: "MEDIUM",
      score: scoreFor("MEDIUM"),
      details: { count24h: recentWithdrawals.length, total24h: recentTotal },
    });
  }

  // 6. Existing open review items compound.
  for (const ev of openEvents) {
    const severity = ev.severity as RiskSignal["severity"];
    signals.push({
      type: `OPEN_FRAUD_EVENT:${ev.event_type}`,
      severity,
      score: Math.round(scoreFor(severity) / 2),
      details: { eventType: ev.event_type },
    });
  }

  const threshold = await thresholds();
  const signalScore = signals.reduce((sum, s) => sum + s.score, 0);
  const score = Math.min(100, input.riskScore + signalScore);

  let recommendedStatus: RiskStatus = "NORMAL";
  if (score >= threshold.suspend) recommendedStatus = "SUSPENDED";
  else if (score >= threshold.restrict) recommendedStatus = "RESTRICTED";
  else if (score >= threshold.review) recommendedStatus = "REVIEW";

  return { score, level: levelFromScore(score, threshold), signals, recommendedStatus };
}

/** Persists the signals an assessment produced. Review-only, never a ban. */
export async function recordSignals(userId: string, signals: RiskSignal[]): Promise<void> {
  if (signals.length === 0) return;
  const admin = createAdminSupabaseClient();

  for (const signal of signals) {
    const { error } = await admin.rpc("record_fraud_event", {
      p_user_id: userId,
      p_type: signal.type,
      p_severity: signal.severity,
      p_score: signal.score,
      p_details: signal.details,
    });
    if (error) {
      logger.error("fraud_event_write_failed", { userId, type: signal.type, error: error.message });
    }
  }
}
