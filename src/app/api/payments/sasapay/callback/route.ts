import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {
  checkCallbackAuthenticity,
  normalizeCallback,
  parseCallbackBody,
} from "@/lib/payments/sasapay/callback";
import { verifyAndSettleDeposit } from "@/server/services/deposits";
import { settleWithdrawalFromProvider } from "@/server/services/withdrawals";
import { describeError, logger } from "@/lib/logger";
import type { Deposit, Withdrawal } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/payments/sasapay/callback
 *
 * Public endpoint (the provider cannot authenticate as a user), therefore
 * treated as untrusted:
 *
 *   1. Authenticity is checked against the configured secret or IP allowlist.
 *      A rejection ends the request immediately.
 *   2. The raw payload is recorded in `payment_events`, with a partial unique
 *      index on (provider, direction, provider_transaction_id) so a replayed
 *      callback is detected rather than double-processed.
 *   3. Settlement goes through the SAME verification path as everything else,
 *      which asks the provider for the authoritative status before any wallet
 *      moves. A forged callback cannot credit a deposit.
 *
 * Always answers 200 for anything we understood, so the provider does not
 * retry indefinitely. Genuine infrastructure failures answer 5xx to invite a
 * retry.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  const authenticity = checkCallbackAuthenticity(request, rawBody);
  if (authenticity.rejected) {
    logger.warn("callback_rejected", { reason: authenticity.reason });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const payload = parseCallbackBody(rawBody);
  if (!payload) {
    logger.warn("callback_unparseable", { length: rawBody.length });
    return NextResponse.json({ ok: true, ignored: true });
  }

  const normalized = normalizeCallback(payload);
  const admin = createAdminSupabaseClient();

  // Record first: this is the audit trail that makes reconciliation possible.
  let duplicate = false;
  const { data: event, error: eventError } = await admin
    .from("payment_events")
    .insert({
      provider: "SASAPAY",
      direction: normalized.direction,
      provider_transaction_id: normalized.providerTransactionId,
      merchant_reference: normalized.merchantReference,
      outcome: normalized.outcome,
      signature_valid: authenticity.verified,
      processed: false,
      payload: normalized.raw,
    })
    .select("id")
    .single<{ id: string }>();

  if (eventError) {
    // Unique violation on provider_transaction_id means a duplicate delivery.
    if (eventError.code === "23505") {
      duplicate = true;
      await admin
        .from("payment_events")
        .update({ duplicate: true })
        .eq("provider_transaction_id", normalized.providerTransactionId);
      await admin.from("reconciliation_alerts").insert({
        alert_type: "DUPLICATE_CALLBACK",
        severity: "LOW",
        entity_type: normalized.direction === "COLLECTION" ? "deposit" : "withdrawal",
        reference: normalized.providerTransactionId,
        details: { merchantReference: normalized.merchantReference, outcome: normalized.outcome },
      });
    } else {
      logger.error("callback_record_failed", { error: eventError.message });
    }
  }

  try {
    if (normalized.direction === "COLLECTION") {
      const { data: deposit } = await admin
        .from("deposits")
        .select("*")
        .or(
          [
            normalized.merchantReference ? `merchant_reference.eq.${normalized.merchantReference}` : null,
            normalized.checkoutRequestId ? `provider_reference.eq.${normalized.checkoutRequestId}` : null,
          ]
            .filter(Boolean)
            .join(","),
        )
        .limit(1)
        .maybeSingle<Deposit>();

      if (!deposit) {
        await admin.from("reconciliation_alerts").insert({
          alert_type: "PAYMENT_NOT_CREDITED",
          severity: "HIGH",
          entity_type: "deposit",
          reference: normalized.merchantReference ?? normalized.checkoutRequestId,
          details: { note: "Callback received for an unknown deposit reference.", payload: normalized.raw },
        });
      } else {
        const outcome = await verifyAndSettleDeposit(deposit);
        logger.info("callback_deposit_settled", {
          depositId: deposit.id,
          status: outcome.status,
          credited: outcome.credited,
          duplicate,
        });
      }
    } else {
      const { data: withdrawal } = await admin
        .from("withdrawals")
        .select("*")
        .or(
          [
            normalized.checkoutRequestId ? `provider_reference.eq.${normalized.checkoutRequestId}` : null,
            normalized.merchantReference?.startsWith("TCW-")
              ? `id.eq.${normalized.merchantReference.slice(4)}`
              : null,
          ]
            .filter(Boolean)
            .join(","),
        )
        .limit(1)
        .maybeSingle<Withdrawal>();

      if (!withdrawal) {
        await admin.from("reconciliation_alerts").insert({
          alert_type: "PROVIDER_COMPLETED_MISSING_LOCAL",
          severity: "HIGH",
          entity_type: "withdrawal",
          reference: normalized.checkoutRequestId ?? normalized.merchantReference,
          details: { note: "Disbursement callback for an unknown withdrawal.", payload: normalized.raw },
        });
      } else {
        const outcome = await settleWithdrawalFromProvider(withdrawal.id);
        logger.info("callback_withdrawal_settled", {
          withdrawalId: withdrawal.id,
          status: outcome.status,
          duplicate,
        });
      }
    }

    if (event?.id) {
      await admin.from("payment_events").update({ processed: true }).eq("id", event.id);
    }
  } catch (error) {
    // Downstream failure: tell the provider to retry rather than losing the event.
    logger.error("callback_processing_failed", {
      error: describeError(error),
    });
    await admin.from("reconciliation_alerts").insert({
      alert_type: "PAYMENT_NOT_CREDITED",
      severity: "CRITICAL",
      entity_type: normalized.direction === "COLLECTION" ? "deposit" : "withdrawal",
      reference: normalized.merchantReference ?? normalized.checkoutRequestId,
      details: {
        note: "Callback processing failed and requires manual reconciliation.",
        error: describeError(error),
      },
    });
    return NextResponse.json({ ok: false, error: "processing_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, duplicate });
}

/** Some providers probe the callback URL with a GET during setup. */
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "sasapay-callback" });
}
