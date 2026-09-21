import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {
  checkCallbackAuthenticity,
  normalizeCallback,
} from "@/lib/payments/payhero/callback";
import { parseCallbackBody } from "@/lib/payments/parse";
import { verifyAndSettleDeposit } from "@/server/services/deposits";
import { settleWithdrawalFromProvider } from "@/server/services/withdrawals";
import { describeError, logger } from "@/lib/logger";
import type { Deposit, Withdrawal } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/payments/payhero/callback
 *
 * Public endpoint (PayHero cannot authenticate as a user), therefore treated as
 * untrusted:
 *
 *   1. Authenticity is checked against the configured secret or IP allowlist.
 *      A rejection ends the request immediately.
 *   2. The raw payload is recorded in `payment_events`, with a partial unique
 *      index on (provider, direction, provider_transaction_id) so a replayed
 *      callback is detected rather than double-processed.
 *   3. Settlement goes through the SAME verification path as every other
 *      deposit and withdrawal, which asks PayHero for the authoritative status
 *      before any wallet moves. A forged callback cannot credit a deposit —
 *      it can at most cause a status lookup.
 *
 * Always answers 200 for anything we understood, so PayHero does not retry
 * indefinitely. Genuine infrastructure failures answer 5xx to invite a retry.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  const authenticity = checkCallbackAuthenticity(request, rawBody);
  if (authenticity.rejected) {
    logger.warn("callback_rejected", { provider: "PAYHERO", reason: authenticity.reason });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const payload = parseCallbackBody(rawBody);
  if (!payload) {
    logger.warn("callback_unparseable", { provider: "PAYHERO", length: rawBody.length });
    return NextResponse.json({ ok: true, ignored: true });
  }

  const normalized = normalizeCallback(payload);
  const admin = createAdminSupabaseClient();

  // Record first: this is the audit trail that makes reconciliation possible.
  let duplicate = false;
  const { data: event, error: eventError } = await admin
    .from("payment_events")
    .insert({
      provider: "PAYHERO",
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
        .eq("provider", "PAYHERO")
        .eq("provider_transaction_id", normalized.providerTransactionId);
      await admin.from("reconciliation_alerts").insert({
        alert_type: "DUPLICATE_CALLBACK",
        severity: "LOW",
        entity_type: normalized.direction === "COLLECTION" ? "deposit" : "withdrawal",
        reference: normalized.providerTransactionId,
        details: { merchantReference: normalized.merchantReference, outcome: normalized.outcome },
      });
    } else {
      logger.error("callback_record_failed", { provider: "PAYHERO", error: eventError.message });
    }
  }

  try {
    if (normalized.direction === "COLLECTION") {
      /*
        Two ways to find the deposit, because the identifiers we hold are not the
        ones PayHero always sends back: `merchant_reference` is our own TCD-…
        reference, which we passed as `external_reference`, while
        `provider_reference` is PayHero's reference from the create response.
        Either one identifying the payment is enough.
      */
      const { data: deposit } = await admin
        .from("deposits")
        .select("*")
        .or(
          [
            normalized.merchantReference
              ? `merchant_reference.eq.${normalized.merchantReference}`
              : null,
            normalized.checkoutRequestId
              ? `provider_reference.eq.${normalized.checkoutRequestId}`
              : null,
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
          details: {
            note: "PayHero callback received for an unknown deposit reference.",
            payload: normalized.raw,
          },
        });
      } else {
        const outcome = await verifyAndSettleDeposit(deposit);
        logger.info("callback_deposit_settled", {
          provider: "PAYHERO",
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
            normalized.checkoutRequestId
              ? `provider_reference.eq.${normalized.checkoutRequestId}`
              : null,
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
          details: {
            note: "PayHero disbursement callback for an unknown withdrawal.",
            payload: normalized.raw,
          },
        });
      } else {
        const outcome = await settleWithdrawalFromProvider(withdrawal.id);
        logger.info("callback_withdrawal_settled", {
          provider: "PAYHERO",
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
    // Downstream failure: tell PayHero to retry rather than losing the event.
    logger.error("callback_processing_failed", {
      provider: "PAYHERO",
      error: describeError(error),
    });
    await admin.from("reconciliation_alerts").insert({
      alert_type: "PAYMENT_NOT_CREDITED",
      severity: "CRITICAL",
      entity_type: normalized.direction === "COLLECTION" ? "deposit" : "withdrawal",
      reference: normalized.merchantReference ?? normalized.checkoutRequestId,
      details: {
        note: "PayHero callback processing failed and requires manual reconciliation.",
        error: describeError(error),
      },
    });
    return NextResponse.json({ ok: false, error: "processing_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, duplicate });
}

/** PayHero probes the callback URL when a channel is configured. */
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "payhero-callback" });
}
