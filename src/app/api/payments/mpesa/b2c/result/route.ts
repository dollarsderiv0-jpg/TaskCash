import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {
  checkMpesaCallbackAuthenticity,
  parseB2cResult,
  parseCallbackBody,
} from "@/lib/payments/mpesa/callback";
import { settleWithdrawalFromProvider } from "@/server/services/withdrawals";
import { describeError, logger } from "@/lib/logger";
import type { Withdrawal } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/payments/mpesa/b2c/result
 *
 * The asynchronous B2C payout result — the ONLY evidence that a payout reached
 * the customer, since Daraja has no synchronous status call for B2C.
 *
 * Because there is no second source to check the claim against, authenticity
 * carries more weight here than on the collection path:
 *
 *   - The event is recorded with `signature_valid` from the source check.
 *   - `settleWithdrawalFromProvider` refuses to mark a payout paid unless that
 *     recorded event was authenticated. A forged POST to this URL therefore
 *     cannot complete a withdrawal — it can only raise an alert, because
 *     marking it paid would remove the user's held funds for a payment that
 *     may never have happened.
 *   - The amount from `ResultParameters` must match the withdrawal's net amount.
 *
 * Always answers 200 with Safaricom's expected acknowledgement so the result is
 * not redelivered indefinitely.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  const authenticity = checkMpesaCallbackAuthenticity(request, rawBody);
  if (authenticity.rejected) {
    logger.warn("mpesa_b2c_callback_rejected", { reason: authenticity.reason });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const payload = parseCallbackBody(rawBody);
  const normalized = payload ? parseB2cResult(payload) : null;

  if (!payload || !normalized) {
    logger.warn("mpesa_b2c_callback_unrecognised", { length: rawBody.length });
    return NextResponse.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const admin = createAdminSupabaseClient();
  const eventKey = normalized.checkoutRequestId ?? normalized.merchantReference;

  if (!authenticity.verified) {
    /*
      Recorded, and deliberately not acted on. An operator resolves it.

      The alert TYPE has to come from the schema's fixed vocabulary
      (`reconciliation_alerts.alert_type` is a CHECK constraint), and the
      distinction that matters — "this arrived from a source we could not
      authenticate" — goes in the note, because inventing a type is not an
      option: an insert the constraint rejects fails SILENTLY unless the error is
      read, and an alert about money that never lands is worse than no alert.
      That is why every insert here checks its error.
    */
    const { error: alertError } = await admin.from("reconciliation_alerts").insert({
      alert_type: "PAYMENT_NOT_CREDITED",
      severity: "CRITICAL",
      entity_type: "withdrawal",
      reference: eventKey,
      details: {
        reason: "UNVERIFIED_CALLBACK_SOURCE",
        note:
          "A B2C payout result arrived from a source that could not be authenticated. It was " +
          "recorded but NOT acted on — the funds stay held. Configure MPESA_CALLBACK_SECRET or " +
          "MPESA_CALLBACK_IPS, then reconcile this payout with Safaricom.",
        outcome: normalized.outcome,
        payload: normalized.raw,
      },
    });

    if (alertError) {
      logger.error("mpesa_b2c_unverified_alert_failed", {
        reference: eventKey,
        error: alertError.message,
      });
    }

    logger.warn("mpesa_b2c_callback_unverified", { reference: eventKey });
    return NextResponse.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  if (eventKey) {
    const { error: eventError } = await admin.from("payment_events").insert({
      provider: "MPESA",
      direction: "DISBURSEMENT",
      provider_transaction_id: eventKey,
      merchant_reference: normalized.merchantReference,
      outcome: normalized.outcome,
      signature_valid: true,
      processed: false,
      payload: normalized.raw,
    });

    if (eventError?.code === "23505") {
      const { error: alertError } = await admin.from("reconciliation_alerts").insert({
        alert_type: "DUPLICATE_CALLBACK",
        severity: "LOW",
        entity_type: "withdrawal",
        reference: eventKey,
        details: { outcome: normalized.outcome, note: "The B2C result was delivered twice." },
      });
      if (alertError) {
        logger.error("mpesa_b2c_duplicate_alert_failed", { error: alertError.message });
      }
    } else if (eventError) {
      logger.error("mpesa_b2c_event_record_failed", { error: eventError.message });
    }
  }

  try {
    // Matched on the conversation id (what we stored as the provider reference)
    // or on our own originator id, so a payout is found either way round.
    const filters = [
      normalized.checkoutRequestId ? `provider_reference.eq.${normalized.checkoutRequestId}` : null,
      normalized.merchantReference ? `provider_reference.eq.${normalized.merchantReference}` : null,
    ]
      .filter(Boolean)
      .join(",");

    const { data: withdrawal } = filters
      ? await admin
          .from("withdrawals")
          .select("*")
          .or(filters)
          .limit(1)
          .maybeSingle<Withdrawal>()
      : { data: null };

    if (!withdrawal) {
      const { error: alertError } = await admin.from("reconciliation_alerts").insert({
        alert_type: "PROVIDER_COMPLETED_MISSING_LOCAL",
        severity: "HIGH",
        entity_type: "withdrawal",
        reference: eventKey,
        details: {
          note: "B2C result received for an unknown withdrawal reference.",
          payload: normalized.raw,
        },
      });
      if (alertError) {
        logger.error("mpesa_b2c_orphan_alert_failed", { error: alertError.message });
      }
    } else {
      const outcome = await settleWithdrawalFromProvider(withdrawal.id);
      logger.info("mpesa_b2c_callback_settled", {
        withdrawalId: withdrawal.id,
        status: outcome.status,
      });
    }
  } catch (error) {
    logger.error("mpesa_b2c_callback_processing_failed", { error: describeError(error) });
    const { error: alertError } = await admin.from("reconciliation_alerts").insert({
      alert_type: "PAYMENT_NOT_CREDITED",
      severity: "CRITICAL",
      entity_type: "withdrawal",
      reference: eventKey,
      details: {
        note: "B2C result processing failed and requires manual reconciliation.",
        error: describeError(error),
      },
    });
    if (alertError) {
      logger.error("mpesa_b2c_failure_alert_failed", { error: alertError.message });
    }
    return NextResponse.json({ ok: false, error: "processing_failed" }, { status: 500 });
  }

  return NextResponse.json({ ResultCode: 0, ResultDesc: "Accepted" });
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "mpesa-b2c-result" });
}
