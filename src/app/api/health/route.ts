import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {
  getSupabaseAdminKey,
  hasMisplacedPublishableKey,
  isProduction,
  missingConfigByCategory,
  publicEnv,
} from "@/lib/env";
import { paymentProviderStatus, payoutReadiness } from "@/lib/payments/provider";
import { readAuthEmailStatus } from "@/lib/supabase/auth-settings";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * For uptime monitors and the deployment platform. Reports whether the
 * application can *do its job*, not just whether the process is up — a Node
 * server that answers 200 while its database is unreachable is not healthy.
 *
 * Everything here is either a status or a variable NAME. No value from the
 * environment is ever included, because a health endpoint is the one URL that
 * gets pasted into tickets, monitors and chat.
 *
 * 200 — the application can serve money and auth.
 * 503 — it cannot. The body says which group is missing, never why in detail.
 */
export async function GET() {
  const missing = missingConfigByCategory();

  // Cheap reachability + schema probe: `system_settings` is created by the
  // first migrations, so it answers both "can we connect" and "has the schema
  // been applied". PGRST205 means the connection works and the table is absent.
  let database: "ok" | "schema_missing" | "unreachable" | "not_configured" = "not_configured";

  if (publicEnv.supabaseUrl && getSupabaseAdminKey()) {
    try {
      const admin = createAdminSupabaseClient();
      const { error } = await admin.from("system_settings").select("key").limit(1);
      if (!error) {
        database = "ok";
      } else if (error.code === "PGRST205" || error.code === "42P01") {
        database = "schema_missing";
      } else {
        database = "unreachable";
        logger.warn("health_database_probe_failed", { code: error.code });
      }
    } catch {
      database = "unreachable";
    }
  }

  const payments = paymentProviderStatus();
  const payout = payoutReadiness();
  // Read from Supabase Auth, which is the service that actually sends these
  // emails. Deliberately NOT from SMTP_* variables: no code in this application
  // reads them (there is no mailer here at all), so reporting them as "email
  // configured" was a green light for the very failure it appeared to rule out.
  const email = await readAuthEmailStatus({
    supabaseUrl: publicEnv.supabaseUrl,
    publishableKey: publicEnv.supabasePublishableKey,
  });

  const healthy =
    missing.server.length === 0 && missing.public.length === 0 && database === "ok";

  return NextResponse.json(
    {
      ok: healthy,
      service: "taskcash-pro",
      environment: isProduction() ? "production" : "development",
      checks: {
        configuration: missing.server.length === 0 ? "ok" : "incomplete",
        // Reported separately because it is the one failure mode with a
        // specific, actionable cause.
        misplacedPublishableKey: hasMisplacedPublishableKey() ? "yes" : "no",
        database,
        // Never "connected" or "working": configured means credentials exist,
        // and nothing more can be claimed without making a payment.
        payments: {
          provider: payments.provider,
          environment: payments.environment,
          // Which host money would be sent to, and — when the host configuration
          // is invalid rather than merely absent — the NAME of the variable at
          // fault. A URL and a variable name, never a credential value. Without
          // this, a host mismatch would leave every deposit failing while this
          // endpoint reported a healthy-looking configuration.
          baseUrl: payments.baseUrl,
          configurationError: payments.configurationError,
          collectionsConfigured: payments.collectionConfigured,
          payoutsConfigured: payments.payoutConfigured,
          payoutMode: payout.mode,
          // Reported because it is the one value that must never be true in
          // production, and a monitor should be able to watch for it: with
          // M-Pesa this is hardcoded false — there is no simulator on that
          // side at all — and only the dormant SasaPay provider can report one.
          simulator: payments.simulator,
          // Deduplicated: for a provider whose collection and payout credentials
          // are the same set (PayHero), concatenating the two lists would report
          // every missing variable twice — a monitor reading this would think
          // six things were unset when three were.
          missing: [...new Set([...payments.missingCollection, ...payments.missingPayout])],
        },
        // Shape changed in this revision: it is an object now, not the string
        // "configured"/"not_configured". See readAuthEmailStatus for why the
        // old value could not be trusted and what is knowable instead.
        email,
      },
      missing: {
        public: missing.public,
        server: missing.server,
        database: missing.database,
      },
    },
    { status: healthy ? 200 : 503 },
  );
}
