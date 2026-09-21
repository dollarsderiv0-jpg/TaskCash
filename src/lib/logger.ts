/**
 * Structured logging.
 *
 * Users never see these records; they are for operator diagnosis. Credentials
 * are redacted before anything is written, so a mis-logged provider response
 * cannot leak a secret key into log storage.
 */

/**
 * A readable shape for a thrown error.
 *
 * supabase-js does not throw `Error` instances — it throws plain objects
 * carrying PostgREST fields (`code`, `message`, `details`, `hint`). Serialising
 * one with `String(error)` produces the literal string "[object Object]", which
 * is how a perfectly diagnosable failure becomes an unreadable log line. That
 * exact loss is what made the original rate-limit failure look mysterious.
 *
 * Never include the raw error's other fields: a fetch error can carry request
 * headers, including an `apikey`.
 */
export function describeError(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  if (error && typeof error === "object") {
    const source = error as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of ["code", "message", "name", "details", "hint"]) {
      const value = source[key];
      if (value === undefined || value === null || value === "") continue;
      out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : String(error);
  }
  return String(error);
}

type Level = "debug" | "info" | "warn" | "error";

const REDACT_KEYS = [
  "access_token",
  "accessToken",
  "refresh_token",
  "client_secret",
  "clientSecret",
  "client_id",
  "clientId",
  "authorization",
  "apikey",
  "service_role",
  "serviceRoleKey",
  "password",
  "secret",
  "token",
];

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const lowered = key.toLowerCase();
      const hit = REDACT_KEYS.some((k) => lowered.includes(k.toLowerCase()));
      out[key] = hit ? "[redacted]" : redact(val, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 800) {
    return `${value.slice(0, 800)}…[truncated]`;
  }
  return value;
}

/** A short, non-guessable id so an operator can find the full record. */
function eventId() {
  return Math.random().toString(36).slice(2, 10);
}

function emit(level: Level, message: string, context?: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(context ? { ctx: redact(context) } : {}),
  };

  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) =>
    process.env.NODE_ENV === "production" ? undefined : emit("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => emit("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => emit("error", message, context),
};

/**
 * Records a provider/payment failure with a safe, non-sensitive shape and
 * returns the internal reference shown to the operator.
 */
export function logPaymentFailure(input: {
  provider: string;
  operation: string;
  requestReference?: string | null;
  responseCode?: string | number | null;
  safeMessage?: string | null;
  error?: unknown;
}): string {
  const internalErrorId = `ERR-${eventId()}`;
  logger.error("payment_failure", {
    provider: input.provider,
    operation: input.operation,
    requestReference: input.requestReference ?? null,
    responseCode: input.responseCode ?? null,
    safeMessage: input.safeMessage ?? null,
    internalErrorId,
    error: input.error instanceof Error ? input.error.message : input.error,
  });
  return internalErrorId;
}
