import { logger } from "@/lib/logger";
import {
  EnvError,
  PLATFORM_NOT_CONFIGURED_MESSAGE,
  PLATFORM_NOT_MIGRATED_MESSAGE,
  missingServerConfigKeys,
} from "@/lib/env";

/**
 * Error handling policy
 * ---------------------
 * Users see a stable, human message. Operators see the real cause in the
 * structured log. Raw Postgres or provider text is never forwarded to the
 * browser.
 */

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function apiError(code: string, message: string, status = 400, details?: unknown) {
  return new ApiError(code, message, status, details);
}

/**
 * Codes PostgREST/Postgres return when an object the migrations create is not
 * there. Seeing one of these means the schema was never applied (or is only
 * half applied) — a configuration fault, not a transient failure.
 */
const MISSING_SCHEMA_CODES = new Set([
  "PGRST205", // table not found in the schema cache
  "PGRST202", // function not found in the schema cache
  "42P01", // undefined_table
  "42883", // undefined_function
]);

const MISSING_SCHEMA_PATTERNS = [
  /could not find the table/i,
  /could not find the function/i,
  /relation "?[\w.]+"? does not exist/i,
  /function [\w."]+ ?\(.*\) does not exist/i,
  /schema cache/i,
];

/**
 * supabase-js throws objects that carry the PostgREST `code` as a property
 * rather than inside `message`, so both have to be inspected.
 */
function errorSignature(error: unknown): { message: string; code: string } {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error ?? "");

  let code = "";
  if (error && typeof error === "object" && "code" in error) {
    const raw = (error as { code?: unknown }).code;
    if (typeof raw === "string") code = raw;
  }
  return { message, code };
}

function isMissingSchemaError(message: string, code: string): boolean {
  if (MISSING_SCHEMA_CODES.has(code)) return true;
  return MISSING_SCHEMA_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * True when a failure means the schema is absent rather than the request being
 * bad. Exported so infrastructure wrappers (the rate limiter) can report the
 * real cause instead of blaming themselves.
 */
export function isMissingSchemaFailure(error: unknown): boolean {
  const { message, code } = errorSignature(error);
  return isMissingSchemaError(message, code);
}

/** Tokens raised by the SQL money functions, mapped to safe user messages. */
const DB_ERROR_MAP: Record<string, { status: number; code: string; message: string }> = {
  INSUFFICIENT_AVAILABLE_BALANCE: {
    status: 409,
    code: "INSUFFICIENT_BALANCE",
    message: "You do not have enough available balance for this request.",
  },
  INSUFFICIENT_LOCKED_BALANCE: {
    status: 409,
    code: "INSUFFICIENT_LOCKED_BALANCE",
    message: "This withdrawal is no longer in a state that can be settled.",
  },
  WALLET_NOT_FOUND: {
    status: 409,
    code: "WALLET_NOT_FOUND",
    message: "Your wallet is not ready yet. Please refresh and try again.",
  },
  WALLET_FROZEN: {
    status: 403,
    code: "WALLET_FROZEN",
    message:
      "Your wallet is temporarily frozen while we review your account. Please contact support.",
  },
  WALLET_CLOSED: {
    status: 403,
    code: "WALLET_CLOSED",
    message: "This wallet is closed and can no longer move funds.",
  },
  PROFILE_NOT_FOUND: {
    status: 404,
    code: "PROFILE_NOT_FOUND",
    message: "We could not find your account. Please sign in again.",
  },
  ACCOUNT_NOT_ACTIVE: {
    status: 403,
    code: "ACCOUNT_NOT_ACTIVE",
    message: "Your account is not active. Please contact support.",
  },
  ACCOUNT_RESTRICTED: {
    status: 403,
    code: "ACCOUNT_RESTRICTED",
    message:
      "Your account is under review and cannot perform this action right now. Please contact support.",
  },
  KYC_REQUIRED: {
    status: 403,
    code: "KYC_REQUIRED",
    message: "Identity verification is required before you can withdraw.",
  },
  EMAIL_VERIFICATION_REQUIRED: {
    status: 403,
    code: "EMAIL_VERIFICATION_REQUIRED",
    message: "Please confirm your email address before earning rewards.",
  },
  CURRENCY_NOT_SUPPORTED: {
    status: 400,
    code: "CURRENCY_NOT_SUPPORTED",
    message: "This currency is not currently supported.",
  },
  WITHDRAWAL_AMOUNT_INVALID: {
    status: 422,
    code: "INVALID_AMOUNT",
    message: "Enter a valid withdrawal amount.",
  },
  WITHDRAWAL_BELOW_MINIMUM: {
    status: 422,
    code: "BELOW_MINIMUM",
    message: "The amount is below the minimum withdrawal for your currency.",
  },
  WITHDRAWAL_ABOVE_MAXIMUM: {
    status: 422,
    code: "ABOVE_MAXIMUM",
    message: "The amount is above the maximum single withdrawal for your currency.",
  },
  WITHDRAWAL_DAILY_LIMIT_EXCEEDED: {
    status: 429,
    code: "DAILY_LIMIT_EXCEEDED",
    message: "This would exceed your rolling 24-hour withdrawal limit.",
  },
  WITHDRAWAL_FEE_INVALID: {
    status: 422,
    code: "FEE_INVALID",
    message: "The configured withdrawal fee is invalid for this amount.",
  },
  PENDING_WITHDRAWAL_EXISTS: {
    status: 409,
    code: "WITHDRAWAL_PENDING",
    message: "You already have a withdrawal in review. Please wait for it to be processed.",
  },
  ACCOUNT_TOO_NEW: {
    status: 403,
    code: "ACCOUNT_TOO_NEW",
    message: "Your account is too new to withdraw. Please try again later.",
  },
  WITHDRAWAL_NOT_FOUND: {
    status: 404,
    code: "WITHDRAWAL_NOT_FOUND",
    message: "That withdrawal request could not be found.",
  },
  WITHDRAWAL_ALREADY_COMPLETED: {
    status: 409,
    code: "WITHDRAWAL_ALREADY_COMPLETED",
    message: "That withdrawal has already been paid and cannot be changed.",
  },
  WITHDRAWAL_NOT_PAYABLE: {
    status: 409,
    code: "WITHDRAWAL_NOT_PAYABLE",
    message: "This withdrawal is no longer in a payable state.",
  },
  WITHDRAWAL_NOT_APPROVED: {
    status: 409,
    code: "WITHDRAWAL_NOT_APPROVED",
    message: "This withdrawal must be approved by an administrator before any payment is sent.",
  },
  WITHDRAWAL_PROVIDER_TX_REUSED: {
    status: 409,
    code: "PROVIDER_TX_REUSED",
    message: "That provider transaction has already been used for another withdrawal.",
  },
  DEPOSIT_NOT_FOUND: {
    status: 404,
    code: "DEPOSIT_NOT_FOUND",
    message: "That deposit could not be found.",
  },
  DEPOSIT_NOT_PAYABLE: {
    status: 409,
    code: "DEPOSIT_NOT_PAYABLE",
    message: "This deposit can no longer be credited.",
  },
  DEPOSIT_PROVIDER_TX_REUSED: {
    status: 409,
    code: "PROVIDER_TX_REUSED",
    message: "That provider transaction has already been credited.",
  },
  SESSION_NOT_FOUND: {
    status: 404,
    code: "SESSION_NOT_FOUND",
    message: "That watch session has expired. Please start the video again.",
  },
  SESSION_CLOSED: {
    status: 409,
    code: "SESSION_CLOSED",
    message: "That watch session is already finished.",
  },
  VIDEO_NOT_FOUND: {
    status: 404,
    code: "VIDEO_NOT_FOUND",
    message: "That video is no longer available.",
  },
  VIDEO_NOT_AVAILABLE: {
    status: 409,
    code: "VIDEO_NOT_AVAILABLE",
    message: "This campaign is no longer active.",
  },
  VIDEO_VIEW_LIMIT_REACHED: {
    status: 409,
    code: "VIEW_LIMIT_REACHED",
    message: "This campaign has reached its viewer limit.",
  },
  VIDEO_DAILY_LIMIT_REACHED: {
    status: 429,
    code: "DAILY_LIMIT_REACHED",
    message: "You have reached today's limit for this video. Try again tomorrow.",
  },
  VIDEO_COOLDOWN_ACTIVE: {
    status: 429,
    code: "COOLDOWN_ACTIVE",
    message: "This video is on cooldown for your account. Please try another one.",
  },
  CAMPAIGN_NOT_PAYABLE: {
    status: 409,
    code: "CAMPAIGN_BUDGET_EXHAUSTED",
    message: "This campaign's reward budget is exhausted, so rewards have stopped for it.",
  },
  VELOCITY_BLOCKED: {
    status: 429,
    code: "VELOCITY_BLOCKED",
    message: "Unusually fast activity detected. Please slow down and try again later.",
  },

  /*
    Packages. PACKAGE_DAILY_LIMIT_REACHED (raised by video_start) and
    PACKAGE_DAILY_LIMIT (raised by video_complete_session when a second session
    consumed the headroom first) are deliberately one user-facing outcome: the
    user has run out of allowance for today and is waiting, not in the wrong.
    The UI pairs this code with `resets_at` from the packages payload to show a
    countdown rather than an error.
  */
  PACKAGE_REQUIRED: {
    status: 403,
    code: "PACKAGE_REQUIRED",
    message: "This video belongs to a package. Activate that package to earn from it.",
  },
  PACKAGE_DAILY_LIMIT_REACHED: {
    status: 409,
    code: "PACKAGE_DAILY_LIMIT_REACHED",
    message: "You have reached this package's earning limit for today. It resets at midnight.",
  },
  PACKAGE_DAILY_LIMIT: {
    status: 409,
    code: "PACKAGE_DAILY_LIMIT_REACHED",
    message: "You have reached this package's earning limit for today. It resets at midnight.",
  },
  /*
    The lifetime ceiling. One user-facing outcome like the daily pair above, but a
    different one: this limit does not reset, so the copy must not promise a
    countdown that will never arrive. The package has paid out everything it can.
  */
  PACKAGE_TOTAL_LIMIT_REACHED: {
    status: 409,
    code: "PACKAGE_TOTAL_LIMIT_REACHED",
    message:
      "This package has paid its full earning allowance. Buy a package again to keep earning from its videos.",
  },
  PACKAGE_TOTAL_LIMIT: {
    status: 409,
    code: "PACKAGE_TOTAL_LIMIT_REACHED",
    message:
      "This package has paid its full earning allowance. Buy a package again to keep earning from its videos.",
  },
  /*
    A term that ended, as distinct from never having bought the package. Saying
    "you need a package" to someone whose 14 days simply ran out reads as a bug.
  */
  PACKAGE_EXPIRED: {
    status: 403,
    code: "PACKAGE_EXPIRED",
    message: "This package's earning period has ended. Buy it again to keep earning from its videos.",
  },
  PACKAGE_NOT_FOUND: {
    status: 404,
    code: "NOT_FOUND",
    message: "That package could not be found.",
  },
  PACKAGE_NOT_AVAILABLE: {
    status: 409,
    code: "PACKAGE_NOT_AVAILABLE",
    message: "This package is not available right now. Please check back shortly.",
  },
  PACKAGE_ALREADY_ACTIVE: {
    status: 409,
    code: "PACKAGE_ALREADY_ACTIVE",
    message: "You already have this package active.",
  },
  PACKAGE_CURRENCY_MISMATCH: {
    status: 409,
    code: "PACKAGE_CURRENCY_MISMATCH",
    message: "This package is priced in a different currency than your wallet.",
  },
  LEDGER_AMOUNT_INVALID: {
    status: 422,
    code: "INVALID_AMOUNT",
    message: "That amount is not valid.",
  },
  LEDGER_REFERENCE_REQUIRED: {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "Something went wrong. Please try again.",
  },
  LEDGER_REFERENCE_CONFLICT: {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "Something went wrong. Please try again.",
  },
  ADJUSTMENT_REASON_REQUIRED: {
    status: 422,
    code: "REASON_REQUIRED",
    message: "A reason is required for a manual wallet adjustment.",
  },
  TICKET_NOT_FOUND: {
    status: 404,
    code: "TICKET_NOT_FOUND",
    message: "We could not find that support request on your account.",
  },
  TICKET_CLOSED: {
    status: 409,
    code: "TICKET_CLOSED",
    message: "That support request is closed. Please start a new one.",
  },
  SUBJECT_REQUIRED: {
    status: 422,
    code: "VALIDATION_ERROR",
    message: "Give your request a short title.",
  },
  MESSAGE_REQUIRED: {
    status: 422,
    code: "VALIDATION_ERROR",
    message: "Tell us what happened, in a sentence or two.",
  },
  INVALID_CATEGORY: {
    status: 422,
    code: "VALIDATION_ERROR",
    message: "Choose what your request is about.",
  },
  // Raised by support_admin_reply() when a non-administrator reaches the RPC.
  // The route guard should already have stopped this; mapping it means a
  // mis-wired route produces a 403 rather than a 500.
  FORBIDDEN: {
    status: 403,
    code: "FORBIDDEN",
    message: "You do not have permission to do that.",
  },
  INVALID_STATUS: {
    status: 422,
    code: "VALIDATION_ERROR",
    message: "That is not a status this request can be moved to.",
  },
};

/** Postgres SQLSTATE / constraint names worth translating explicitly. */
const CONSTRAINT_MAP: Record<string, { status: number; code: string; message: string }> = {
  profiles_email_key: {
    status: 409,
    code: "EMAIL_TAKEN",
    message: "An account with that email address already exists.",
  },
  wallets_user_id_key: {
    status: 409,
    code: "WALLET_EXISTS",
    message: "That wallet already exists.",
  },
  withdrawals_idempotency_key_key: {
    status: 409,
    code: "DUPLICATE_REQUEST",
    message: "That request has already been submitted.",
  },
  deposits_merchant_reference_key: {
    status: 409,
    code: "DUPLICATE_REFERENCE",
    message: "That payment reference already exists.",
  },
};

function findToken(message: string, table: Record<string, unknown>): string | null {
  for (const key of Object.keys(table)) {
    if (message.includes(key)) return key;
  }
  return null;
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  const { message, code } = errorSignature(error);

  // Checked before the token maps: an unapplied schema would otherwise fall
  // through to a generic 500 and read like a transient outage.
  if (isMissingSchemaError(message, code)) {
    logger.error("platform_not_migrated", {
      code,
      error: message,
      action: "npm run db:migrate",
    });
    return new ApiError("PLATFORM_NOT_MIGRATED", PLATFORM_NOT_MIGRATED_MESSAGE, 503);
  }

  const dbToken = findToken(message, DB_ERROR_MAP);
  if (dbToken) {
    const mapped = DB_ERROR_MAP[dbToken];
    // A raised token is expected business logic, not an incident.
    if (mapped.status < 500) {
      logger.warn("api_business_rule", { token: dbToken });
      return new ApiError(mapped.code, mapped.message, mapped.status);
    }
  }

  // A configuration fault is the operator's problem, not the caller's — but
  // the caller should be told the service is not ready rather than being
  // invited to retry something that cannot possibly succeed.
  if (error instanceof EnvError || message.includes("is not configured")) {
    // Names only — an operator needs to know what to set, never the values.
    logger.error("platform_not_configured", { error: message, missing: missingServerConfigKeys() });
    return new ApiError("PLATFORM_NOT_CONFIGURED", PLATFORM_NOT_CONFIGURED_MESSAGE, 503);
  }

  const constraintToken = findToken(message, CONSTRAINT_MAP);
  if (constraintToken) {
    const mapped = CONSTRAINT_MAP[constraintToken];
    return new ApiError(mapped.code, mapped.message, mapped.status);
  }

  if (message.includes("duplicate key value")) {
    return new ApiError("DUPLICATE_RECORD", "That record already exists.", 409);
  }

  logger.error("unhandled_api_error", {
    error: error instanceof Error ? error.stack ?? error.message : message,
  });

  return new ApiError("INTERNAL_ERROR", "Something went wrong. Please try again.", 500);
}
