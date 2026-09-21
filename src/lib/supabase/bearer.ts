import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createSupabaseContext } from "@supabase/server";
import { ApiError } from "@/lib/api/errors";
import { getPublicSupabaseConfig, getSupabaseAdminKey, getSupabaseJwksUrl } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Header-based authentication for API callers.
 *
 * The rest of the application authenticates with cookies (`@supabase/ssr`), and
 * that stays the default — it is what the browser uses and it is verified and
 * tested. What was missing is a way for a caller that is *not* a browser to
 * authenticate at all: a mobile client, a script, an integration. Such a caller
 * presents `Authorization: Bearer <access token>`, and this module turns that
 * token into an identity.
 *
 * Two properties matter more than anything else here:
 *
 *  1. **The client returned is scoped to the caller.** It carries the caller's
 *     token to PostgREST, so Row Level Security decides what they can see. This
 *     is why the token is never exchanged for a service-role client: doing so
 *     would turn "authenticated" into "can read every wallet".
 *  2. **A presented token is authoritative.** If a token is supplied and does not
 *     verify, the request is refused. It is never silently downgraded to the
 *     cookie session, which would let an expired or forged token ride on a
 *     valid cookie and report a success the caller did not earn.
 *
 * `createSupabaseContext` also builds an admin client (it requires a secret key
 * to construct at all). That client grants access this module has no business
 * granting, so it is deliberately never returned or re-exported from here.
 */

/** A JWT is three dot-separated base64url segments. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export type BearerCaller = {
  /** Scoped to the caller: RLS policies apply to every query made with it. */
  client: SupabaseClient;
  user: User;
};

/** Extracts the token from an `Authorization` header, or null. */
export function readBearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((header ?? "").trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/**
 * True when a token is shaped like a JWT.
 *
 * This exists so Bearer authentication does not swallow other schemes that
 * legitimately use the same header. The cron endpoint, for instance, presents
 * `Authorization: Bearer <CRON_SECRET>` and never claims to be a user. A value
 * that is not JWT-shaped is not a Supabase token, so it is left alone for
 * whoever it belongs to. Anything that *does* claim to be a JWT is verified
 * strictly — the looseness is only about which credential we are looking at,
 * never about whether it is valid.
 */
export function isJwtShaped(token: string): boolean {
  return JWT_SHAPE.test(token);
}

/**
 * Verifies a bearer token and returns a caller-scoped client.
 *
 * Verification is two-layered on purpose:
 *
 *  1. **Locally, against the project's JWKS**, which proves the token was signed
 *     by this project's auth service and has not expired. This is the step that
 *     makes a forged token useless, and it needs no network round trip.
 *  2. **Against the auth service**, via `getUser(token)`, which is the only
 *     place `email_confirmed_at` comes from. The email verification gate reads
 *     that field, and it must keep coming from the auth service rather than from
 *     a value the application writes.
 *
 * The two must agree on the user id. A mismatch means one of them is wrong, and
 * guessing which would be unsound, so it is refused.
 *
 * If `SUPABASE_JWKS_URL` is not configured, step 1 is skipped rather than
 * failing: the auth service remains the verifier, so the request is still
 * authenticated — just with a network call that JWKS would have avoided.
 * Verification is never abandoned because an optimisation is unavailable.
 */
export async function resolveBearerCaller(token: string): Promise<BearerCaller> {
  const { url, key } = getPublicSupabaseConfig();
  const secretKey = getSupabaseAdminKey();
  const jwksUrl = getSupabaseJwksUrl();

  if (!secretKey) {
    // Not a caller error: the deployment cannot build the server context at
    // all, so reporting 401 would send the caller hunting for a bad token.
    logger.error("bearer_context_unavailable", { reason: "SUPABASE_SECRET_KEY is not configured" });
    throw new ApiError(
      "PLATFORM_NOT_CONFIGURED",
      "The platform backend is not configured.",
      503,
    );
  }

  if (!jwksUrl) {
    logger.warn("bearer_jwks_not_configured", {
      impact: "token signature is verified by the auth service instead of locally",
    });
  }

  const request = new Request("https://taskcash.internal/", {
    headers: { Authorization: `Bearer ${token}` },
  });

  const { data: ctx, error } = await createSupabaseContext(request, {
    auth: "user",
    env: {
      url,
      publishableKeys: { default: key },
      secretKeys: { default: secretKey },
      jwks: jwksUrl ? new URL(jwksUrl) : null,
    },
  });

  if (error) {
    // The library's error carries `code`, `message` and `hint`. The message can
    // quote the token's own claims, so it is logged, never returned.
    logger.warn("bearer_token_rejected", {
      code: error.code ?? null,
      message: error.message,
      hint: error.hint ?? null,
    });
    throw new ApiError(
      "UNAUTHORIZED",
      "Your session could not be verified. Please sign in again.",
      401,
    );
  }

  const claimsUserId = ctx.userClaims?.id ?? null;
  if (!claimsUserId) {
    logger.warn("bearer_token_without_subject", { authMode: ctx.authMode });
    throw new ApiError(
      "UNAUTHORIZED",
      "Your session could not be verified. Please sign in again.",
      401,
    );
  }

  const {
    data: { user },
    error: userError,
  } = await ctx.supabase.auth.getUser(token);

  if (userError || !user) {
    logger.warn("bearer_token_unknown_to_auth", { code: userError?.code ?? null });
    throw new ApiError(
      "UNAUTHORIZED",
      "Your session could not be verified. Please sign in again.",
      401,
    );
  }

  if (user.id !== claimsUserId) {
    logger.error("bearer_identity_mismatch", {
      fromJwt: claimsUserId,
      fromAuth: user.id,
    });
    throw new ApiError(
      "UNAUTHORIZED",
      "Your session could not be verified. Please sign in again.",
      401,
    );
  }

  return { client: ctx.supabase, user };
}
