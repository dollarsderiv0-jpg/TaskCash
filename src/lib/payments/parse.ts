/**
 * Defensive readers for provider payloads.
 *
 * Every payment provider returns loosely-typed JSON whose field names drift
 * between API versions, and a callback is untrusted input by definition. These
 * helpers read a value from a list of candidate keys and coerce it, so a
 * provider renaming a field degrades to `null` (which we refuse to settle on)
 * rather than throwing or — far worse — reading the wrong field as an amount.
 *
 * Shared by every provider. `sasapay/client.ts` re-exports them so existing
 * imports keep working.
 */

export function pickString(
  payload: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!payload) return null;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

export function pickNumber(
  payload: Record<string, unknown> | null | undefined,
  keys: string[],
): number | null {
  if (!payload) return null;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/,/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function pickBoolean(
  payload: Record<string, unknown> | null | undefined,
  keys: string[],
): boolean | null {
  if (!payload) return null;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const lowered = value.trim().toLowerCase();
      if (lowered === "true") return true;
      if (lowered === "false") return false;
    }
  }
  return null;
}

/**
 * Several providers spell "ok" in more than one way — a boolean `status`, a
 * string `"success"`, or a numeric `ResponseCode` of `0`. All of them mean
 * "the request was accepted", never "the money moved".
 */
export function providerSaysOk(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload) return false;

  const status = payload.status;
  if (typeof status === "boolean") return status;
  if (typeof status === "string") {
    const lowered = status.toLowerCase();
    return lowered === "true" || lowered === "success" || lowered === "0" || lowered === "00";
  }

  const code = payload.ResponseCode ?? payload.ResultCode ?? payload.resultCode;
  if (typeof code === "string" || typeof code === "number") {
    const asString = String(code);
    return asString === "0" || asString === "00" || asString === "000" || asString === "200";
  }

  return false;
}

/**
 * Parses a raw request body that may be JSON, a JSON array, or form-encoded.
 *
 * Shared by every provider's callback route: a provider's content type is a
 * claim, not a fact, and a callback we refuse to parse is a payment we never
 * settle.
 */
export function parseCallbackBody(rawBody: string): Record<string, unknown> | null {
  if (!rawBody) return null;
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    // Some providers deliver a JSON array of results.
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object") {
      return parsed[0] as Record<string, unknown>;
    }
    return null;
  } catch {
    // Some callbacks arrive as form-encoded bodies.
    try {
      const params = new URLSearchParams(rawBody);
      const out: Record<string, unknown> = {};
      for (const [key, value] of params.entries()) out[key] = value;
      return Object.keys(out).length > 0 ? out : null;
    } catch {
      return null;
    }
  }
}

/**
 * Constant-time string comparison.
 *
 * Used for shared secrets and HMAC digests, where a length-leaking or
 * early-exit comparison would let an attacker recover a secret one byte at a
 * time from response timing.
 */
export function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Reads the `Error` shape every provider uses for a failed request. */
export function providerErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  return pickString(payload as Record<string, unknown>, [
    "detail",
    "errorMessage",
    "message",
    "ErrorMessage",
    "error_description",
  ]);
}
