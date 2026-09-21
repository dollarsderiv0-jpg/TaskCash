import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { checkMpesaCallbackAuthenticity, parseCallbackBody } from "@/lib/payments/mpesa/callback";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/payments/mpesa/b2c/timeout
 *
 * The queue-timeout notification. It says one thing only: the request sat in
 * Safaricom's queue longer than the timeout and the outcome is **unknown** —
 * it does not mean the payout failed, and it does not mean it succeeded.
 *
 * So nothing is settled here. In particular the held funds are NOT released:
 * releasing would risk paying the customer twice if the payout later lands, and
 * completing would pay for something that may never have happened. The correct
 * response is to keep the money held, raise a high-severity alert, and let an
 * operator confirm the outcome with Safaricom before either happens.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  const authenticity = checkMpesaCallbackAuthenticity(request, rawBody);
  if (authenticity.rejected) {
    logger.warn("mpesa_b2c_timeout_rejected", { reason: authenticity.reason });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const payload = parseCallbackBody(rawBody);

  // The timeout body reuses the result shape but carries no ResultParameters,
  // so it is parsed loosely and only its identifiers are used.
  const result = (payload?.Result ?? {}) as Record<string, unknown>;
  const reference =
    (typeof result.ConversationID === "string" && result.ConversationID) ||
    (typeof result.OriginatorConversationID === "string" && result.OriginatorConversationID) ||
    null;

  const admin = createAdminSupabaseClient();

  /*
    `STALE_PENDING` rather than a new type: `alert_type` is a CHECK constraint,
    so an invented value is rejected — and, unless the error is read, rejected
    silently. An alert that never lands is exactly how a timed-out payout would
    sit unnoticed with a user's money held. The type is from the schema's
    vocabulary; the nuance goes in the note.
  */
  const { error: alertError } = await admin.from("reconciliation_alerts").insert({
    alert_type: "STALE_PENDING",
    severity: "HIGH",
    entity_type: "withdrawal",
    reference,
    details: {
      reason: "PROVIDER_QUEUE_TIMEOUT",
      note:
        "Safaricom reported a B2C queue timeout. The payout outcome is unknown, so the funds stay " +
        "held and the withdrawal stays in processing until an operator confirms it with Safaricom.",
      verifiedSource: authenticity.verified,
      payload: payload ?? null,
    },
  });

  if (alertError) {
    logger.error("mpesa_b2c_timeout_alert_failed", {
      reference,
      error: alertError.message,
    });
  }

  logger.warn("mpesa_b2c_timeout", { reference, verified: authenticity.verified });

  return NextResponse.json({ ResultCode: 0, ResultDesc: "Accepted" });
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "mpesa-b2c-timeout" });
}
