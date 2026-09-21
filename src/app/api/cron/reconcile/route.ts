import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { verifyAndSettleDeposit } from "@/server/services/deposits";
import { sweepProviderPayments } from "@/server/services/reconciliation";
import { settleWithdrawalFromProvider } from "@/server/services/withdrawals";
import { safeEqual } from "@/lib/hash";
import { activePaymentProvider, missingProviderEnv, providerConfigured } from "@/lib/env";
import { describeError, logger } from "@/lib/logger";
import type { Deposit, Withdrawal } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/cron/reconcile
 *
 * Scheduled sweep (Vercel Cron, or any external scheduler). It re-verifies
 * payments that are still unresolved and raises alerts for anything stuck.
 * It is protected by CRON_SECRET and refuses to run without it in production.
 *
 * Suggested schedule: every 10 minutes.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      logger.error("cron_secret_missing");
      return NextResponse.json({ ok: false, error: "CRON_SECRET is not configured" }, { status: 503 });
    }
  } else {
    const provided =
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      new URL(request.url).searchParams.get("secret") ??
      "";

    if (!safeEqual(provided, secret)) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }

  // Reconciliation means "ask the provider what actually happened". With no
  // provider there is nothing to ask, and a sweep that cannot verify anything
  // must not report a clean run: an empty summary would read as "all payments
  // checked out", which is the one thing it does not mean.
  //
  // Either direction being configured is enough to be useful: collections alone
  // can still confirm unresolved deposits, and the sweep reports which provider
  // it is asking on behalf of.
  const canReconcile = providerConfigured("COLLECT") || providerConfigured("PAYOUT");
  if (!canReconcile) {
    logger.warn("cron_reconcile_skipped", { reason: "payment provider not configured" });
    return NextResponse.json(
      {
        ok: false,
        skipped: true,
        reason:
          "The payment provider is not configured, so no transaction could be verified. " +
          "Nothing was reconciled.",
        provider: activePaymentProvider(),
        missing: [...new Set([...missingProviderEnv("COLLECT"), ...missingProviderEnv("PAYOUT")])],
      },
      { status: 503 },
    );
  }

  const admin = createAdminSupabaseClient();
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const staleCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const summary = {
    depositsChecked: 0,
    depositsCredited: 0,
    depositsFailed: 0,
    withdrawalsChecked: 0,
    withdrawalsCompleted: 0,
    alertsRaised: 0,
    /*
      The provider-side direction. Everything above starts from a local record;
      this is the only part of the sweep that can notice money the provider took
      with no local record at all.
    */
    providerTransactionsRead: 0,
    providerPaymentsSettled: 0,
    providerAlertsRaised: 0,
    providerSweepSkipped: false,
    issues: [] as string[],
  };

  // Unresolved deposits older than five minutes: the customer has had time to
  // approve the prompt, so ask the provider what actually happened.
  const { data: pendingDeposits } = await admin
    .from("deposits")
    .select("*")
    .in("status", ["PENDING", "PROCESSING"])
    .lt("created_at", cutoff)
    .limit(50);

  for (const deposit of (pendingDeposits ?? []) as Deposit[]) {
    summary.depositsChecked += 1;
    try {
      const outcome = await verifyAndSettleDeposit(deposit);
      if (outcome.status === "COMPLETED") summary.depositsCredited += 1;
      if (outcome.status === "FAILED" || outcome.status === "CANCELLED") summary.depositsFailed += 1;
    } catch (error) {
      logger.error("cron_deposit_reconcile_failed", {
        depositId: deposit.id,
        error: describeError(error),
      });
    }
  }

  const { data: processingWithdrawals } = await admin
    .from("withdrawals")
    .select("*")
    .eq("status", "PROCESSING")
    .lt("admin_approved_at", cutoff)
    .limit(50);

  for (const withdrawal of (processingWithdrawals ?? []) as Withdrawal[]) {
    summary.withdrawalsChecked += 1;
    try {
      const outcome = await settleWithdrawalFromProvider(withdrawal.id);
      if (outcome.status === "COMPLETED") summary.withdrawalsCompleted += 1;
    } catch (error) {
      logger.error("cron_withdrawal_reconcile_failed", {
        withdrawalId: withdrawal.id,
        error: describeError(error),
      });
    }
  }

  // Anything still unanswered after an hour is an operator problem.
  const { data: staleDeposits } = await admin
    .from("deposits")
    .select("id, merchant_reference, amount, currency")
    .in("status", ["PENDING", "PROCESSING"])
    .lt("created_at", staleCutoff)
    .limit(50);

  for (const deposit of (staleDeposits ?? []) as {
    id: string;
    merchant_reference: string;
    amount: number;
  }[]) {
    const { data: existing } = await admin
      .from("reconciliation_alerts")
      .select("id")
      .eq("reference", deposit.merchant_reference)
      .eq("status", "OPEN")
      .maybeSingle<{ id: string }>();

    if (!existing) {
      await admin.from("reconciliation_alerts").insert({
        alert_type: "STALE_PENDING",
        severity: "HIGH",
        entity_type: "deposit",
        entity_id: deposit.id,
        reference: deposit.merchant_reference,
        details: { amount: deposit.amount, note: "Deposit unresolved for over an hour." },
      });
      summary.alertsRaised += 1;
    }
  }

  /*
    And the inverse direction: pull the provider's own transactions and report
    any that were paid without a matching local credit. This is the only check
    that catches a payment we never recorded. It never credits on its own — a
    paid transaction with an open deposit goes through verifyAndSettleDeposit,
    and anything else is raised as an alert for a human.
  */
  try {
    const sweep = await sweepProviderPayments();
    summary.providerTransactionsRead = sweep.providerTransactionsRead;
    summary.providerPaymentsSettled = sweep.settled;
    summary.providerAlertsRaised = sweep.alertsRaised;
    summary.providerSweepSkipped = sweep.skipped;
    if (sweep.skipped && sweep.reason) summary.issues.push(sweep.reason);
    summary.issues.push(...sweep.issues);
  } catch (error) {
    // A sweep that could not run is not a clean run, and the caller must be able
    // to tell the difference.
    summary.issues.push(`Provider sweep failed: ${describeError(error)}`);
    logger.error("cron_provider_sweep_failed", { error: describeError(error) });
  }

  logger.info("cron_reconcile_complete", summary);
  /*
    `ok` is false when the provider side could not be read, even though the local
    half may have run cleanly. A caller that pages on `ok` should not be told a
    sweep succeeded when part of it did not happen.
  */
  const complete = summary.issues.length === 0 && !summary.providerSweepSkipped;
  return NextResponse.json({ ok: complete, ...summary });
}
