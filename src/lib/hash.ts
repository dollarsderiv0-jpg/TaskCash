import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * Anti-fraud signals need to correlate requests without storing raw personal
 * identifiers. IPs and device fingerprints are therefore stored as keyed
 * HMACs: stable enough to link abuse, useless if the database leaks.
 */

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 16) {
    // Never silently degrade to an unkeyed hash.
    throw new Error(
      "AUTH_SECRET is not configured (min 16 chars). Refusing to hash identifiers.",
    );
  }
  return value;
}

export function hashIdentifier(scope: string, value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return createHmac("sha256", secret()).update(`${scope}:${trimmed}`).digest("hex").slice(0, 64);
}

/** Extracts the caller IP from proxy headers without trusting a single hop blindly. */
export function clientIpFromHeaders(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return (
    headers.get("cf-connecting-ip") ??
    headers.get("x-real-ip") ??
    headers.get("x-vercel-forwarded-for") ??
    null
  );
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Signs a short-lived payload (used for high-value approval confirmations). */
export function signPayload(payload: Record<string, unknown>, ttlSeconds = 300): string {
  const body = JSON.stringify({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
  const encoded = Buffer.from(body).toString("base64url");
  const mac = createHmac("sha256", secret()).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}

export function verifySignedPayload<T = Record<string, unknown>>(token: string): T | null {
  const [encoded, mac] = token.split(".");
  if (!encoded || !mac) return null;
  const expected = createHmac("sha256", secret()).update(encoded).digest("base64url");
  if (!safeEqual(mac, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      exp?: number;
    };
    if (typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}
