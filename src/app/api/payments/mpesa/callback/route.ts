import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {
  checkMpesaCallbackAuthenticity,
  parseCallbackBody,
  parseStkCallback,
} from "@/lib/payments/mpesa/callback";
import { verifyAndSettleDeposit } from "@/server/services/deposits";
import { describeError, logger } from "@/lib/logger";
import type { Deposit } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/payments/mpesa/callback
 *
 * The M-Pesa Express (STK) result. Public endpoint — Safaricom cannot
 * authenticate as a user — therefore treated as untrusted input:
 *
 *   1. Source authenticity is checked against MPESA_CALLBACK_SECRET or
 *      MPESA_CALLBACK_IPS. A rejection ends the request immediately.
 *   2. The raw payload is recorded in `payment_events` BEFORE settlement. That
 *      ordering matters for M-Pesa specifically: an STK status query reports the
 *      outcome but NOT the amount, so the amount that protects the credit can
 *      only come from this callback's metadata. verify.ts reads it back from
 *      that record.
 *   3. A partial unique index on (provider, direction, provider_transaction_id)
 *      detects a replayed callback instead of double-processing it.
 *   4. Settlement goes through the same path as everything else, which asks
 *      Safaricom for the authoritative status and checks the amount before any
 *      wallet moves. A forged callback cannot credit a deposit.
 *
 * Always answers 200 for anything we understood, so Safaricom does not retry
 * indefinitely. A genuine infrastructure failure answers 5xx to invite a retry.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  const authenticity = checkMpesaCallbackAuthenticity(request, rawBody);
  if (authenticity.rejected) {
    logger.warn("mpesa_callback_rejected", { reason: authenticity.reason });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const payload = parseCallbackBody(rawBody);
  const normalized = payload ? parseStkCallback(payload) : null;

  if (!payload || !normalized) {
    // Not an STK callback (or not parseable). Acknowledge without acting: the
    // alternative is inventing a transaction out of an unrecognised body.
    logger.warn("mpesa_callback_unrecognised", { length: rawBody.length });
    return NextResponse.json({ ok: true, ignored: true });
  }

  const admin = createAdminSupabaseClient();

  // The checkout request id is the stable key across both a failed callback (no
  // receipt) and a successful one, so it is what duplicate detection is on.
  const eventKey = normalized.checkoutRequestId ?? normalized.providerTransactionId;

  let duplicate = false;
  let eventId: string | null = null;

  if (eventKey) {
    const { data: event, error: eventError } = await admin
      .from("payment_events")
      .insert({
        provider: "MPESA",
        direction: "COLLECTION",
        provider_transaction_id: eventKey,
        merchant_reference: normalized.checkoutRequestId,
        outcome: normalized.outcome,
        signature_valid: authenticity.verified,
        processed: false,
        payload: normalized.raw,
      })
      .select("id")
      .single<{ id: string }>();

    if (eventError) {
      if (eventError.code === "23505") {
        duplicate = true;
        const { error: alertError } = await admin.from("reconciliation_alerts").insert({
          alert_type: "DUPLICATE_CALLBACK",
          severity: "LOW",
          entity_type: "deposit",
          reference: eventKey,
          details: { outcome: normalized.outcome, note: "Safaricom delivered this STK result twice." },
        });
        // An alert insert can be refused by the schema's CHECK constraint; a
        // silent failure here would hide a replayed callback.
        if (alertError) {
          logger.error("mpesa_duplicate_alert_failed", { error: alertError.message });
        }
      } else {
        logger.error("mpesa_callback_record_failed", { error: eventError.message });
      }
    } else {
      eventId = event?.id ?? null;
    }
  }

  try {
    const { data: deposit } = normalized.checkoutRequestId
      ? await admin
          .from("deposits")
          .select("*")
          .eq("provider_reference", normalized.checkoutRequestId)
          .limit(1)
          .maybeSingle<Deposit>()
      : { data: null };

    if (!deposit) {
      const { error: alertError } = await admin.from("reconciliation_alerts").insert({
        alert_type: "PAYMENT_NOT_CREDITED",
        severity: "HIGH",
        entity_type: "deposit",
        reference: normalized.checkoutRequestId,
        details: {
          note: "M-Pesa callback received for an unknown checkout request id.",
          payload: normalized.raw,
        },
      });
      if (alertError) {
        logger.error("mpesa_unknown_deposit_alert_failed", { error: alertError.message });
      }
      logger.warn("mpesa_callback_unknown_deposit", {
        checkoutRequestId: normalized.checkoutRequestId,
      });
    } else {
      const outcome = await verifyAndSettleDeposit(deposit);
      logger.info("mpesa_callback_deposit_settled", {
        depositId: deposit.id,
        status: outcome.status,
        credited: outcome.credited,
        duplicate,
      });
    }

    if (eventId) {
      await admin.from("payment_events").update({ processed: true }).eq("id", eventId);
    }
  } catch (error) {
    logger.error("mpesa_callback_processing_failed", { error: describeError(error) });
    const { error: alertError } = await admin.from("reconciliation_alerts").insert({
      alert_type: "PAYMENT_NOT_CREDITED",
      severity: "CRITICAL",
      entity_type: "deposit",
      reference: normalized.checkoutRequestId,
      details: {
        note: "STK callback processing failed and requires manual reconciliation.",
        error: describeError(error),
      },
    });
    if (alertError) {
      logger.error("mpesa_failure_alert_failed", { error: alertError.message });
    }
    return NextResponse.json({ ok: false, error: "processing_failed" }, { status: 500 });
  }

  // Safaricom's expected acknowledgement shape.
  return NextResponse.json({ ResultCode: 0, ResultDesc: "Accepted" });
}

/** Safaricom probes the callback URL with a GET when it is registered. */
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "mpesa-stk-callback" });
}
