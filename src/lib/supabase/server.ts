import { createServerClient, type SetAllCookies } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { getPublicSupabaseConfig } from "@/lib/env";
import { isJwtShaped, readBearerToken } from "@/lib/supabase/bearer";

/**
 * Request-scoped Supabase client for Server Components and route handlers.
 *
 * This client carries the caller's credentials, so every query is evaluated
 * against the row level security policies in 0004_rls.sql. It is the *only*
 * client used for reading a user's own data.
 *
 * Whichever way the caller authenticated, the same client comes back:
 *
 *  - **Browser.** The session cookie, as before.
 *  - **`Authorization: Bearer <access token>`.** The token is attached to the
 *    client, so PostgREST evaluates the query as that user.
 *
 * That second case is why this lives here rather than in each caller. Services
 * such as `getWalletOverview` build their own client, and a bearer request used
 * to reach them with no cookie at all: the query then matched no rows and the
 * service answered `null` instead of failing. A balance that is silently absent
 * is worse than one that errors, so the token is carried centrally — one place
 * to get right, and no service has to know how the caller authenticated.
 *
 * Precedence is deliberate and does not depend on ordering: the SDK only falls
 * back to the session token when the request carries no `Authorization` of its
 * own, so a bearer caller is queried as themselves even if a cookie is also
 * present. Identity and data can therefore never disagree about who is asking.
 *
 * The key stays the *publishable* one. The token narrows access; it never
 * widens it.
 */
export async function createServerSupabaseClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const { url, key } = getPublicSupabaseConfig();

  // Only a value that claims to be a JWT is attached. `Authorization` is not
  // exclusive to Supabase — the cron endpoint presents a shared secret in the
  // same header — and forwarding a non-token to PostgREST would turn every such
  // request into an authentication error.
  const token = readBearerToken((await headers()).get("authorization"));
  const bearer = token && isJwtShaped(token) ? token : null;

  return createServerClient(url, key, {
    ...(bearer ? { global: { headers: { Authorization: `Bearer ${bearer}` } } } : {}),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: Parameters<SetAllCookies>[0]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component render, where cookies are
          // read-only. Session refresh is handled in middleware instead.
        }
      },
    },
  });
}
