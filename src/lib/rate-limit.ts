import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { describeError, logger } from "@/lib/logger";
import { ApiError, isMissingSchemaFailure } from "@/lib/api/errors";
import { humanWait } from "@/lib/duration";
import {
  PLATFORM_NOT_CONFIGURED_MESSAGE,
  PLATFORM_NOT_MIGRATED_MESSAGE,
  hasSupabaseAdminCredentials,
  missingServerConfigKeys,
} from "@/lib/env";

export type RateLimitMode = "open" | "closed";

/**
 * What a caller may do next. When `allowed` is false, `retryAfterSeconds` is
 * the exact number of seconds until the counter's window rolls over, measured
 * by the database that owns the window rather than estimated here.
 */
export type RateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
  hits: number;
  limit: number;
  /** Present only when the count could not be read, so the caller allowed it. */
  degraded?: boolean;
};

/**
 * The noun for each bucket, so a refusal names the action the caller actually
 * took. "Too many attempts" is unhelpful when someone just tried to sign in and
 * equally unhelpful when they tried to join.
 */
const BUCKET_SUBJECTS: Record<string, string> = {
  "auth:register": "registration attempts",
  "auth:login": "sign-in attempts",
  "auth:login:email": "sign-in attempts for this email address",
  "auth:reset": "password reset requests",
  "auth:resend": "verification emails",
  "deposit:create": "deposit requests",
  "withdrawal:create": "withdrawal requests",
  "support:ticket": "support requests",
};

function rateLimitedError(bucket: string, decision: RateLimitDecision): ApiError {
  const subject = BUCKET_SUBJECTS[bucket] ?? "attempts";
  const retryAfterSeconds = Math.max(1, Math.floor(decision.retryAfterSeconds));

  return new ApiError(
    "RATE_LIMITED",
    `Too many ${subject}. Please try again in ${humanWait(retryAfterSeconds)}.`,
    429,
    { retryAfterSeconds, limit: decision.limit },
  );
}

const UNLIMITED: RateLimitDecision = {
  allowed: true,
  retryAfterSeconds: 0,
  hits: 0,
  limit: 0,
};

/**
 * Database-backed rate limiting. Serverless instances do not share memory, so
 * counters live in Postgres and are incremented atomically by
 * public.rate_limit_hit_info().
 *
 * `mode` decides what happens if the limiter itself fails:
 *   - "closed" (auth, withdrawals): refuse the request. Brute force is worse
 *     than a transient error.
 *   - "open" (low-risk reads): allow the request and log the incident.
 */
export async function checkRateLimit(
  bucket: string,
  identifier: string,
  limit: number,
  windowSeconds: number,
  mode: RateLimitMode = "open",
): Promise<RateLimitDecision> {
  if (limit <= 0) return { ...UNLIMITED, limit };

  let decision: RateLimitDecision | null = null;
  let failure: unknown = null;

  try {
    decision = await hit(bucket, identifier, limit, windowSeconds);
  } catch (error) {
    // The limiter working correctly is not an error to report on.
    if (error instanceof ApiError && error.code === "RATE_LIMITED") throw error;

    // A deployment migrated to 0007 answers the old yes/no question but cannot
    // report a retry time. That is still safe, so fall back instead of refusing
    // every request until someone runs a migration -- and log it, because the
    // fallback is why this caller gets a full-window estimate rather than the
    // real one.
    if (isMissingRetryTimeSupport(error)) {
      logger.warn("rate_limit_retry_time_unavailable", {
        bucket,
        action: "apply supabase/migrations/0008_rate_limit_retry_after.sql",
      });
      try {
        const allowed = await legacyHit(bucket, identifier, limit, windowSeconds);
        decision = allowed
          ? { ...UNLIMITED, limit }
          : {
              allowed: false,
              // 0007 cannot say when, so report a whole window: never promise a
              // shorter wait than the truth.
              retryAfterSeconds: windowSeconds,
              hits: limit + 1,
              limit,
            };
      } catch (legacyError) {
        // The fallback is not a rescue from a broken limiter -- it is an older
        // question asked of the same limiter. If it also fails, the failure is
        // the original one and is classified below, not swallowed here.
        failure = legacyError;
      }
    } else {
      failure = error;
    }
  }

  if (decision) {
    if (!decision.allowed) throw rateLimitedError(bucket, decision);
    return decision;
  }

  return classifyRateLimitFailure(bucket, mode, failure, limit);
}

/**
 * Turns a limiter fault into the right outcome, in one place, so the mapping
 * from "what broke" to "what the caller is told" can be read as a table rather
 * than reconstructed across a catch block.
 */
function classifyRateLimitFailure(
  bucket: string,
  mode: RateLimitMode,
  error: unknown,
  limit: number,
): RateLimitDecision {
  if (error instanceof ApiError) throw error;
  logger.error("rate_limit_unavailable", { bucket, mode, error: describeError(error) });

  // A limiter that cannot reach its store because the deployment has no
  // database is a configuration fault, not a blip. Report it as one, so the
  // operator is not sent chasing a phantom rate-limit outage. Still fails
  // closed: the request is refused either way.
  if (!hasSupabaseAdminCredentials()) {
    logger.error("platform_not_configured", {
      bucket,
      missing: missingServerConfigKeys(),
    });
    throw new ApiError("PLATFORM_NOT_CONFIGURED", PLATFORM_NOT_CONFIGURED_MESSAGE, 503);
  }

  // Configured, but the limiter's own table is missing: the migrations have
  // never been applied. Without this the caller is told the limiter is
  // unavailable and invited to retry, when no retry can ever help.
  if (isMissingSchemaFailure(error)) {
    logger.error("platform_not_migrated", { bucket, action: "npm run db:migrate" });
    throw new ApiError("PLATFORM_NOT_MIGRATED", PLATFORM_NOT_MIGRATED_MESSAGE, 503);
  }

  if (mode === "closed") {
    throw new ApiError(
      "RATE_LIMIT_UNAVAILABLE",
      "We could not safely process that request right now. Please try again shortly.",
      503,
    );
  }

  // mode === "open": a low-risk read proceeds. An unreachable limiter is not a
  // reason to break browsing, and the incident is on the log either way.
  logger.warn("rate_limit_degraded_open", { bucket });
  return { ...UNLIMITED, limit, degraded: true };
}

/**
 * Throws when the caller has exhausted `bucket`. Kept as the primary entry
 * point so callers that only care about pass/fail stay unchanged.
 */
export async function enforceRateLimit(
  bucket: string,
  identifier: string,
  limit: number,
  windowSeconds: number,
  mode: RateLimitMode = "open",
): Promise<void> {
  await checkRateLimit(bucket, identifier, limit, windowSeconds, mode);
}

/** Calls rate_limit_hit_info() (migration 0008) and reads its answer. */
async function hit(
  bucket: string,
  identifier: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitDecision> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.rpc("rate_limit_hit_info", {
    p_bucket: bucket,
    p_identifier: identifier,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });

  if (error) throw error;

  const payload = (data ?? {}) as {
    allowed?: boolean;
    retry_after_seconds?: number;
    hits?: number;
    limit?: number;
  };
  const allowed = payload.allowed !== false;

  return {
    allowed,
    retryAfterSeconds: allowed ? 0 : Math.max(0, Number(payload.retry_after_seconds) || 0),
    hits: Number(payload.hits) || 0,
    limit: Number(payload.limit) || limit,
  };
}

/** Pre-0008 yes/no call, used only when the retry-time function is absent. */
async function legacyHit(
  bucket: string,
  identifier: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.rpc("rate_limit_hit", {
    p_bucket: bucket,
    p_identifier: identifier,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) throw error;
  return data !== false;
}

/**
 * True when the failure is specifically "the retry-time function is missing",
 * as opposed to a genuinely unapplied schema.
 *
 * The distinction matters: rate_limits lands in 0002, so a missing *function*
 * means only 0008 has not been applied, while a missing *table* means the
 * database was never migrated and must keep its PLATFORM_NOT_MIGRATED
 * classification.
 */
function isMissingRetryTimeSupport(error: unknown): boolean {
  const signature = errorSignature(error);

  // Name the function explicitly. A missing *table* means the database was
  // never migrated and must keep its PLATFORM_NOT_MIGRATED classification, so
  // this must not fire for one.
  if (!/rate_limit_hit_info/i.test(signature)) return false;

  // Both conditions are required. "permission denied for function
  // rate_limit_hit_info" names the same function, but is a privilege fault:
  // retrying through the older function would fail identically, and reporting
  // it as an unmigrated deployment would send the operator to run a migration
  // that changes nothing.
  return /could not find the function|does not exist|schema cache|PGRST202|42883/i.test(
    signature,
  );
}

function errorSignature(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error ?? "");
  } catch {
    return "";
  }
}

/**
 * Counters for a window that has passed can never influence another decision,
 * but without pruning the table grows by one row per bucket per caller per
 * window forever. Routed through the database so the same "strictly older than
 * any live window" rule applies in one place.
 */
export async function pruneRateLimits(): Promise<number | null> {
  try {
    const admin = createAdminSupabaseClient();
    const { data, error } = await admin.rpc("rate_limit_prune", { p_older_than_seconds: 86400 });
    if (error) throw error;
    return typeof data === "number" ? data : null;
  } catch (error) {
    logger.warn("rate_limit_prune_failed", { error: describeError(error) });
    return null;
  }
}

/**
 * Limits are per caller, per window, and counted in the database.
 *
 * Registration is the strictest because it is the only unauthenticated write
 * that creates a row in another system. Note that in a development build the
 * auth buckets are deliberately wider: the identifier is derived from the
 * caller's address, so every browser on one machine shares a single budget and
 * a strict production limit makes local testing impossible after a few
 * accounts. The relaxation is chosen server-side from NODE_ENV -- there is no
 * header, query parameter or client value that can influence it, so production
 * behaviour cannot be reached from a browser.
 */
function limit(production: number, development: number): number {
  return process.env.NODE_ENV === "production" ? production : development;
}

export const RATE_LIMITS = {
  login: { bucket: "auth:login", limit: limit(8, 60), window: 300, mode: "closed" as RateLimitMode },
  register: {
    bucket: "auth:register",
    limit: limit(5, 50),
    window: 3600,
    mode: "closed" as RateLimitMode,
  },
  passwordReset: {
    bucket: "auth:reset",
    limit: limit(5, 30),
    window: 3600,
    mode: "closed" as RateLimitMode,
  },
  // Resending a verification email costs someone else's bandwidth (the mail
  // provider's) and can be aimed at a victim's inbox, so it is limited per
  // account as well as per IP. Three per hour is far more than a real person
  // needs and far less than an abuse run wants.
  verificationResend: {
    bucket: "auth:resend",
    limit: limit(3, 30),
    window: 3600,
    mode: "closed" as RateLimitMode,
  },
  depositCreate: {
    bucket: "deposit:create",
    limit: limit(10, 60),
    window: 600,
    mode: "closed" as RateLimitMode,
  },
  withdrawalCreate: {
    bucket: "withdrawal:create",
    limit: limit(5, 30),
    window: 600,
    mode: "closed" as RateLimitMode,
  },
  /*
    Buying a package is a financial mutation, but a small limit is wrong here:
    the failure mode of a tight cap is a user who genuinely wants a second tier
    being told to wait. The real protection against double spending is not this
    limiter — it is the one-active-purchase-per-package index and the ledger's
    non-negative balance check, both inside package_purchase.
  */
  packagePurchase: {
    bucket: "package:purchase",
    limit: limit(6, 30),
    window: 600,
    mode: "closed" as RateLimitMode,
  },
  videoStart: { bucket: "video:start", limit: 60, window: 600, mode: "open" as RateLimitMode },
  videoProgress: { bucket: "video:progress", limit: 240, window: 600, mode: "open" as RateLimitMode },
  videoComplete: { bucket: "video:complete", limit: 60, window: 600, mode: "open" as RateLimitMode },
  // A person with a real problem writes one or two tickets, not thirty. This is
  // low enough to stop a script filling the support queue and high enough that
  // nobody legitimate ever meets it.
  supportTicket: {
    bucket: "support:ticket",
    limit: limit(5, 30),
    window: 3600,
    mode: "closed" as RateLimitMode,
  },
  adminMutation: {
    bucket: "admin:mutation",
    limit: 120,
    window: 600,
    mode: "closed" as RateLimitMode,
  },
  callback: { bucket: "payment:callback", limit: 600, window: 600, mode: "open" as RateLimitMode },
} as const;
