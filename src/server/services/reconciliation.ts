import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { paymentProviderId } from "@/lib/payments/provider";
import {
  listProviderTransactions,
  type ProviderPayment,
} from "@/lib/payments/payhero/transactions";
import {
  classifyProviderPayment,
  type LocalDepositFacts,
  type ReconcileDecision,
} from "@/lib/payments/reconcile";
import { verifyAndSettleDeposit } from "@/server/services/deposits";
import { providerConfigured, missingProviderEnv } from "@/lib/env";
import { describeError, logger } from "@/lib/logger";
import type { Deposit } from "@/lib/types";

/**
 * The provider-side sweep.
 *
 * Every other reconciliation path in this product starts from a local record and
 * asks the provider about it. This one runs the other way: it pulls the
 * provider's own transaction list and asks "what did you take that we have no
 * record of?" That is the only direction that can notice money that arrived and
 * was never credited — a deposit whose row was lost, or one we never created at
 * all.
 *
 * It never credits anything it has not verified. A paid provider transaction with
 * an open local deposit is handed to the ordinary settlement path
 * (`verifyAndSettleDeposit`), which re-asks the provider and credits at most
 * once. Anything else — no local deposit, an amount that disagrees, a deposit we
 * already told the customer had failed — is raised as an alert for a human,
 * because there is no automatic action that is unambiguously correct.
 *
 * Reporting honestly matters more here than anywhere else in the codebase: a
 * sweep that cannot read the provider's response, or that cannot ask at all, must
 * say so. An empty summary reads as "every payment checks out", which is exactly
 * what it does not mean.
 */

/** How many provider pages to read. Newest first, so this is the recent window. */
const MAX_PAGES = 5;
const PER_PAGE = 100;

/** Alert fields we persist, so a decision maps to a row in one place. */
type AlertInsert = {
  alert_type: string;
  severity: string;
  entity_type: string;
  entity_id: string | null;
  reference: string;
  details: Record<string, unknown>;
};

export type SweepSummary = {
  skipped: boolean;
  reason?: string;
  provider: string;
  /** Provider transactions read from the provider. */
  providerTransactionsRead: number;
  /** Rows the provider sent that carried no reference we could read. */
  unreadableRows: number;
  /** True when rows arrived but we understood none of them. */
  formatUnrecognised: boolean;
  /** What envelope the rows were found in, for diagnosis. */
  envelope: string;
  /** Paid provider transactions we hold no local deposit for. */
  missingLocal: number;
  /** Paid provider transactions for a deposit still open — settled here. */
  settled: number;
  /** Paid provider transactions whose amount disagrees with our record. */
  amountMismatch: number;
  /** Paid provider transactions for a deposit we had closed as failed. */
  notCredited: number;
  /** Alerts newly written (existing open alerts are not duplicated). */
  alertsRaised: number;
  /** Alerts that already existed for the same reference and type. */
  alertsAlreadyOpen: number;
  /** Anything that stopped the sweep from being complete. */
  issues: string[];
};

function emptySummary(provider: string): SweepSummary {
  return {
    skipped: false,
    provider,
    providerTransactionsRead: 0,
    unreadableRows: 0,
    formatUnrecognised: false,
    envelope: "(none)",
    missingLocal: 0,
    settled: 0,
    amountMismatch: 0,
    notCredited: 0,
    alertsRaised: 0,
    alertsAlreadyOpen: 0,
    issues: [],
  };
}

function toLocalFacts(deposit: Deposit): LocalDepositFacts {
  return {
    id: deposit.id,
    merchantReference: deposit.merchant_reference,
    amount: Number(deposit.amount),
    currency: deposit.currency,
    status: deposit.status,
  };
}

/**
 * Matches one provider payment to our deposit.
 *
 * Prefers our own reference (`external_reference`, echoed back by PayHero)
 * because we minted it and it is unique to the deposit. Falls back to the
 * provider's reference, which we stored as `provider_reference` when the
 * collection was initiated. A payment with neither is unmatched by definition and
 * is reported as such rather than guessed at.
 */
function findDeposit(
  payment: ProviderPayment,
  byMerchantReference: Map<string, Deposit>,
  byProviderReference: Map<string, Deposit>,
): Deposit | null {
  if (payment.externalReference) {
    const found = byMerchantReference.get(payment.externalReference);
    if (found) return found;
  }
  if (payment.reference) {
    const found = byProviderReference.get(payment.reference);
    if (found) return found;
  }
  return null;
}

function alertFor(decision: Extract<ReconcileDecision, { action: "ALERT" }>): AlertInsert {
  return {
    alert_type: decision.alertType,
    severity: decision.severity,
    entity_type: decision.entityType,
    entity_id: decision.entityId,
    reference: decision.reference,
    details: decision.details,
  };
}

export type SweepInput = { maxPages?: number; perPage?: number };

/**
 * Runs one provider-side sweep.
 *
 * Read-only with respect to the provider (a `GET`), and idempotent with respect
 * to the ledger: settlement goes through the same verified, once-only path used
 * by callbacks and the "I have paid" button, and alerts are deduplicated against
 * the open ones already on file.
 */
export async function sweepProviderPayments(input: SweepInput = {}): Promise<SweepSummary> {
  const provider = paymentProviderId();
  const summary = emptySummary(provider);

  /*
    Only PayHero exposes a transaction list we can read. For any other provider
    there is nothing to ask, and returning a clean summary would be a lie: it
    would read as "the provider took nothing we missed". So the sweep declines,
    and names the provider it declined for.
  */
  if (provider !== "PAYHERO") {
    return {
      ...summary,
      skipped: true,
      reason:
        `Provider-side reconciliation is implemented for PayHero only. The active provider is ` +
        `${provider}, so the provider's transaction list was not read and nothing was checked.`,
    };
  }

  if (!providerConfigured("COLLECT")) {
    return {
      ...summary,
      skipped: true,
      reason:
        "The payment provider is not configured, so its transactions could not be read. " +
        "Nothing was reconciled.",
      issues: missingProviderEnv("COLLECT"),
    };
  }

  const admin = createAdminSupabaseClient();
  const maxPages = Math.min(Math.max(input.maxPages ?? MAX_PAGES, 1), MAX_PAGES);
  const perPage = Math.min(Math.max(input.perPage ?? PER_PAGE, 1), 200);

  const payments: ProviderPayment[] = [];
  let pagesRead = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    let pageResult;
    try {
      pageResult = await listProviderTransactions({ page, perPage });
    } catch (error) {
      /*
        A page we could not read makes the sweep incomplete, and incompleteness is
        the one thing that must not read as success. Recorded as an issue and we
        stop paging rather than skipping silently to the next page.
      */
      summary.issues.push(
        `Could not read provider transactions page ${page}: ${describeError(error)}`,
      );
      break;
    }

    pagesRead += 1;
    summary.providerTransactionsRead += pageResult.items.length;
    summary.unreadableRows += pageResult.unreadable;
    summary.envelope = pageResult.envelope;
    if (pageResult.formatUnrecognised) summary.formatUnrecognised = true;

    payments.push(...pageResult.items);

    // A short page is the last page.
    if (pageResult.items.length < perPage) break;
  }

  if (summary.formatUnrecognised) {
    summary.issues.push(
      "The provider returned rows but none carried a reference we could read, so no payment could " +
        "be matched. The response shape may have changed — this is not a clean run.",
    );
  }

  if (summary.unreadableRows > 0) {
    summary.issues.push(
      `${summary.unreadableRows} provider row(s) carried no reference we could read and could not ` +
        "be matched against a deposit.",
    );
  }

  /*
    One query per identifier set rather than one per payment: a page of 100 rows
    would otherwise be 100 round trips. Both sets are bounded by the page size.
  */
  const merchantReferences = [
    ...new Set(payments.map((p) => p.externalReference).filter((v): v is string => Boolean(v))),
  ];
  const providerReferences = [
    ...new Set(payments.map((p) => p.reference).filter((v): v is string => Boolean(v))),
  ];

  const byMerchantReference = new Map<string, Deposit>();
  const byProviderReference = new Map<string, Deposit>();

  if (merchantReferences.length > 0) {
    const { data } = await admin
      .from("deposits")
      .select("*")
      .in("merchant_reference", merchantReferences);
    for (const row of (data ?? []) as Deposit[]) byMerchantReference.set(row.merchant_reference, row);
  }

  if (providerReferences.length > 0) {
    const { data } = await admin
      .from("deposits")
      .select("*")
      .in("provider_reference", providerReferences);
    for (const row of (data ?? []) as Deposit[]) {
      if (row.provider_reference) byProviderReference.set(row.provider_reference, row);
    }
  }

  for (const payment of payments) {
    const deposit = findDeposit(payment, byMerchantReference, byProviderReference);
    const decision = classifyProviderPayment(
      {
        reference: payment.reference,
        externalReference: payment.externalReference,
        amount: payment.amount,
        outcome: payment.outcome,
        receipt: payment.receipt,
        phone: payment.phone,
        occurredAt: payment.occurredAt,
      },
      deposit ? toLocalFacts(deposit) : null,
    );

    if (decision.action === "SKIP") continue;

    if (decision.action === "SETTLE") {
      /*
        The provider confirms it and the deposit is still open. Rather than
        crediting here, hand it to the ordinary verified settlement path, so
        there is exactly one place in the codebase that credits a deposit.
      */
      if (!deposit) continue;
      try {
        const outcome = await verifyAndSettleDeposit(deposit);
        if (outcome.status === "COMPLETED") {
          summary.settled += 1;
          logger.info("sweep_provider_payment_settled", {
            merchantReference: deposit.merchant_reference,
            credited: outcome.credited,
            duplicate: outcome.duplicate,
          });
        } else {
          // The provider said paid, but settlement could not confirm it — or the
          // amount disagreed during settlement. Either way it needs a human.
          summary.issues.push(
            `Deposit ${deposit.merchant_reference} could not be settled from the sweep: ${outcome.message}`,
          );
        }
      } catch (error) {
        summary.issues.push(
          `Deposit ${deposit.merchant_reference} failed to settle from the sweep: ${describeError(error)}`,
        );
      }
      continue;
    }

    // decision.action === "ALERT"
    if (decision.alertType === "PROVIDER_COMPLETED_MISSING_LOCAL") summary.missingLocal += 1;
    if (decision.alertType === "AMOUNT_MISMATCH") summary.amountMismatch += 1;
    if (decision.alertType === "PAYMENT_NOT_CREDITED") summary.notCredited += 1;

    const alert = alertFor(decision);

    // One alert per (reference, type) while it is still open. A sweep runs often,
    // and a queue that grows by one row per run is a queue nobody reads.
    const { data: existing } = await admin
      .from("reconciliation_alerts")
      .select("id")
      .eq("reference", alert.reference)
      .eq("alert_type", alert.alert_type)
      .eq("status", "OPEN")
      .maybeSingle<{ id: string }>();

    if (existing) {
      summary.alertsAlreadyOpen += 1;
      continue;
    }

    const { error } = await admin.from("reconciliation_alerts").insert(alert);
    if (error) {
      summary.issues.push(
        `Could not raise a ${alert.alert_type} alert for ${alert.reference}: ${error.message}`,
      );
      continue;
    }

    summary.alertsRaised += 1;
    logger.warn("sweep_provider_payment_alert", {
      alertType: alert.alert_type,
      severity: alert.severity,
      reference: alert.reference,
      amount: alert.details.amount ?? alert.details.provider ?? null,
    });
  }

  logger.info("sweep_provider_payments_complete", {
    // `summary` already carries `provider`.
    pagesRead,
    ...summary,
  });

  return summary;
}
