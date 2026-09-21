import { NextResponse } from "next/server";
import { ApiError, toApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

/**
 * Every response carries a `requestId` the user can quote and an operator can
 * grep for. Failures additionally expose `code` and `message` at the top level
 * as flat aliases of `error.code` / `error.message`, so a client (or a log
 * pipeline) can read either shape without breaking the other.
 */
export type ApiEnvelope<T> =
  | { ok: true; data: T; requestId: string }
  | {
      ok: false;
      error: { code: string; message: string; details?: unknown };
      code: string;
      message: string;
      /**
       * Present on RATE_LIMITED (and any future "come back later" code). A
       * caller that knows the real wait can show a countdown instead of
       * inviting a retry that cannot succeed.
       */
      retryAfterSeconds?: number;
      requestId: string;
    };

function requestId() {
  return Math.random().toString(36).slice(2, 12);
}

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
} as const;

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json<ApiEnvelope<T>>(
    { ok: true, data, requestId: requestId() },
    { status: 200, ...init, headers: { ...NO_STORE, ...(init?.headers ?? {}) } },
  );
}

export function fail(code: string, message: string, status = 400, details?: unknown) {
  const retryAfterSeconds = readRetryAfter(details);

  return NextResponse.json<ApiEnvelope<never>>(
    {
      ok: false,
      error: { code, message, details },
      code,
      message,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      requestId: requestId(),
    },
    {
      status,
      headers: {
        ...NO_STORE,
        // The standard way to say "come back later". Proxies, retry libraries
        // and the browser all understand it without parsing the body.
        ...(retryAfterSeconds === undefined ? {} : { "Retry-After": String(retryAfterSeconds) }),
      },
    },
  );
}

function readRetryAfter(details: unknown): number | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.ceil(value);
}

/**
 * Error boundary for route handlers. Any throw becomes a well-formed,
 * non-leaking JSON error. Financial responses are always uncacheable.
 */
export async function runApi(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.status >= 500) {
      // The message says which status it actually was: logging every server-side
      // failure as "api_500" is how a 503 configuration fault gets mistaken for
      // a 500 defect.
      logger.error("api_failure", {
        status: apiError.status,
        code: apiError.code,
        message: apiError.message,
      });
    }
    return fail(apiError.code, apiError.message, apiError.status, apiError.details);
  }
}

/** Parses JSON bodies defensively — a malformed body is a 400, not a 500. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    throw new ApiError("INVALID_JSON", "The request body was not valid JSON.", 400);
  }
}
