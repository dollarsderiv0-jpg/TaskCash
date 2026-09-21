"use client";

/**
 * Client API helper.
 *
 * Centralises two things:
 *  1. A persistent, randomly generated device identifier sent as `x-device-id`.
 *     The server stores only a keyed hash of it, and uses it as one weak
 *     anti-fraud signal — never as an authentication factor.
 *  2. The response envelope, so every form handles errors the same way and
 *     only ever displays the safe, server-mapped message.
 */

const DEVICE_KEY = "taskcash.device";

export function deviceId(): string {
  if (typeof window === "undefined") return "";
  try {
    const existing = window.localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const generated =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `d-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    window.localStorage.setItem(DEVICE_KEY, generated);
    return generated;
  } catch {
    // Private browsing or storage disabled: proceed without a device id.
    return "";
  }
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const id = deviceId();
  return {
    "Content-Type": "application/json",
    ...(id ? { "x-device-id": id } : {}),
    ...extra,
  };
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; code: string; fields?: Record<string, string> };

export async function apiRequest<T>(
  url: string,
  options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown } = {},
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: headers(),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
    });

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    const envelope = parsed as
      | { ok: true; data: T }
      | { ok: false; error?: { code?: string; message?: string; details?: { fields?: Record<string, string> } } }
      | null;

    if (response.ok && envelope && envelope.ok) {
      return { ok: true, data: envelope.data };
    }

    if (envelope && envelope.ok === false) {
      return {
        ok: false,
        code: envelope.error?.code ?? "ERROR",
        message: envelope.error?.message ?? "Something went wrong. Please try again.",
        fields: envelope.error?.details?.fields,
      };
    }

    return {
      ok: false,
      code: response.status === 401 ? "UNAUTHORIZED" : "ERROR",
      message:
        response.status === 401
          ? "Your session has expired. Please sign in again."
          : "Something went wrong. Please try again.",
    };
  } catch {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      message: "We could not reach the server. Check your connection and try again.",
    };
  }
}

/** Idempotency key factory so a double-tap cannot create two operations. */
export function newIdempotencyKey(scope: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return `${scope}:${random}`;
}
