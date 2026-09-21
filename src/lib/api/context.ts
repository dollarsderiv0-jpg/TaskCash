import { clientIpFromHeaders, hashIdentifier } from "@/lib/hash";

/**
 * Request context used by auth, anti-fraud and audit logging.
 *
 * Raw IP addresses and device identifiers are never persisted — only keyed
 * HMACs, so the values cannot be reversed if the database is exposed.
 */

export type RequestContext = {
  ip: string | null;
  ipHash: string | null;
  deviceHash: string | null;
  userAgent: string | null;
};

export function requestContext(request: Request, deviceId?: string | null): RequestContext {
  const ip = clientIpFromHeaders(request.headers);
  const device = deviceId ?? request.headers.get("x-device-id") ?? null;
  const userAgent = request.headers.get("user-agent");

  let ipHash: string | null = null;
  let deviceHash: string | null = null;

  try {
    ipHash = hashIdentifier("ip", ip);
    deviceHash = hashIdentifier("device", device);
  } catch {
    // AUTH_SECRET missing: hashing is unavailable. Signals are simply not
    // recorded rather than being stored in raw form.
    ipHash = null;
    deviceHash = null;
  }

  return { ip, ipHash, deviceHash, userAgent };
}

/** Stable identifier for rate limiting: prefer the account, fall back to IP. */
export function rateLimitIdentifier(userId: string | null, ctx: RequestContext, fallback: string) {
  return userId ?? anonymousRateLimitIdentifier(ctx, fallback);
}

/**
 * Identifier for a caller who is not signed in yet.
 *
 * Only the keyed hash is ever used. The previous fallback chain ended at the
 * raw address, which contradicted this module's own promise that raw IPs are
 * never persisted -- and it only triggered in exactly the situation where the
 * value was most likely to reach a log or a support ticket.
 *
 * When no address can be resolved at all, every such caller shares one budget.
 * That is deliberately the strict direction, but it is a *deployment* fault
 * (a reverse proxy that forwards no client-address header, or a missing
 * AUTH_SECRET), not a user fault, so it is labelled as shared rather than
 * silently attributed to an imaginary caller.
 */
export function anonymousRateLimitIdentifier(
  ctx: RequestContext,
  shared = "shared:unidentified",
): string {
  return ctx.ipHash ?? shared;
}
