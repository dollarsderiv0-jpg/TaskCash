import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { isMissingSchemaFailure } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

/**
 * App installs — "does this account have the app on a device?"
 *
 * The answer decides one thing: whether the wallet screen shows the withdrawal
 * limits, or points at the app instead. It is read from the profile (a durable,
 * server-side fact) and never from the browser, which can be cleared, spoofed or
 * simply be a different device.
 *
 * Migration 0018 may not be applied yet. In that state the honest answer is "not
 * recorded" — the limits stay hidden and the app keeps working — so every path
 * here degrades to that rather than failing.
 */

/** Where the report came from. Kept so the trail says which signal fired. */
export type AppInstallSource = "STANDALONE" | "APPINSTALLED" | "MANUAL";

export type AppInstallResult = {
  /** True when the report was stored. False when the schema is not there yet. */
  recorded: boolean;
  /** When the account first got the app, or null when nothing is recorded. */
  firstAt: string | null;
};

export async function recordAppInstall(input: {
  userId: string;
  source: AppInstallSource;
  userAgent: string | null;
}): Promise<AppInstallResult> {
  const admin = createAdminSupabaseClient();

  const { data, error } = await admin.rpc("record_app_install", {
    p_user_id: input.userId,
    p_source: input.source,
    p_user_agent: input.userAgent,
  });

  if (error) {
    if (isMissingSchemaFailure(error)) {
      logger.warn("app_install_not_recorded", {
        reason: "migration 0018 is not applied",
        fix: "npm run db:bundle, then db:push-sql",
      });
      return { recorded: false, firstAt: null };
    }
    throw error;
  }

  const firstAt = (Array.isArray(data) ? data[0] : data) as string | null;
  return { recorded: true, firstAt: firstAt ?? null };
}

/*
  There is deliberately no `hasAppInstall()` reader here.

  The question is already answered on the session: `getSessionUser()` selects the
  profile, so `session.profile.app_downloaded_at` is the same fact without a
  second round trip, and reading it there keeps the answer tied to the caller's
  own row rather than to an id the caller supplied. `app_downloaded_at` is typed
  optional for exactly that read, so a database without migration 0018 reports
  "not installed" instead of failing.
*/
