import { headers } from "next/headers";
import type { User } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { isJwtShaped, readBearerToken, resolveBearerCaller } from "@/lib/supabase/bearer";
import { logger } from "@/lib/logger";
import type { Profile, Wallet } from "@/lib/types";

export type SessionUser = {
  authUserId: string;
  email: string | null;
  emailConfirmed: boolean;
  profile: Profile;
  wallet: Wallet;
};

/**
 * Finds how the caller authenticated, and returns their client and identity.
 *
 * Two mechanisms are supported, in this priority order:
 *
 *  1. **`Authorization: Bearer <access token>`** — for callers that are not a
 *     browser. Verified in `@/lib/supabase/bearer`; a token that is present but
 *     invalid is refused rather than quietly ignored, so an expired token can
 *     never fall through to a cookie.
 *  2. **The session cookie** — the browser path, unchanged, and still what
 *     every existing screen uses.
 *
 * A non-JWT Bearer value is left alone. `Authorization` is not exclusive to
 * Supabase: the cron endpoint presents a shared secret in the same header, and
 * treating that as an access token would break it. So the branch is only taken
 * when the value actually claims to be a JWT — and once it does, it is verified
 * strictly.
 *
 * Both paths return a client scoped to the caller, never a privileged one, so
 * Row Level Security remains the thing that authorises every read below.
 */
async function resolveCaller(): Promise<{
  client: Awaited<ReturnType<typeof createServerSupabaseClient>>;
  user: User;
} | null> {
  const token = readBearerToken((await headers()).get("authorization"));

  if (token && isJwtShaped(token)) {
    const caller = await resolveBearerCaller(token);
    return { client: caller.client, user: caller.user };
  }

  const supabase = await createServerSupabaseClient();

  // getUser() validates the token against the auth server, rather than
  // getSession(), which would trust a client-supplied cookie payload.
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;
  return { client: supabase, user };
}

/**
 * The signed-in user, together with the client that carries their credentials.
 *
 * `getSessionUser()` is this without the client. The client is needed for the
 * case a bare `SessionUser` cannot serve: a SECURITY DEFINER function that reads
 * `auth.uid()` to decide who it is acting for. The service-role client carries
 * no user token, so `auth.uid()` is null inside such a function and it refuses
 * the call — which is why `/api/redeem` answered 500 for every valid code.
 *
 * Both are resolved from ONE authentication, so returning the client does not
 * add a second token validation to a request.
 */
export type SessionContext = {
  user: SessionUser;
  /**
   * The caller's own client, never a privileged one. The key stays the
   * *publishable* one, so Row Level Security still authorises every read —
   * the token narrows access, it never widens it.
   */
  supabase: SupabaseLike;
};

export async function getSessionContext(): Promise<SessionContext | null> {
  const caller = await resolveCaller();
  if (!caller) return null;
  const user = await loadProfileAndWallet(caller.client, caller.user);
  if (!user) return null;
  return { user, supabase: caller.client };
}

/**
 * Resolves the signed-in user, however they authenticated.
 *
 * Profile and wallet reads run through the caller's own client, so the row
 * level security policies are what actually authorise the read — the identity
 * above decides *who* is asking, never *what* they may see.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  return (await getSessionContext())?.user ?? null;
}

type SupabaseLike = Awaited<ReturnType<typeof createServerSupabaseClient>>;

async function loadProfileAndWallet(
  supabase: SupabaseLike,
  user: User,
): Promise<SessionUser | null> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("auth_user_id", user.id)
    .maybeSingle<Profile>();

  if (profile) {
    const { data: wallet } = await supabase
      .from("wallets")
      .select("*")
      .eq("user_id", profile.id)
      .maybeSingle<Wallet>();

    if (wallet) {
      return {
        authUserId: user.id,
        email: user.email ?? null,
        emailConfirmed: Boolean(user.email_confirmed_at),
        profile,
        wallet,
      };
    }
  }

  // Self-healing: an auth user without a profile/wallet (for example if the
  // provisioning trigger was added after the account existed). Provisioning
  // is idempotent and server-side only.
  logger.warn("session_missing_profile", { authUserId: user.id });
  const admin = createAdminSupabaseClient();
  const { error: provisionError } = await admin.rpc("ensure_profile", {
    p_auth_user_id: user.id,
    p_email: user.email ?? `${user.id}@placeholder.invalid`,
    p_metadata: (user.user_metadata ?? {}) as Record<string, unknown>,
  });

  if (provisionError) {
    logger.error("session_provision_failed", { authUserId: user.id, error: provisionError.message });
    return null;
  }

  const { data: profile2 } = await supabase
    .from("profiles")
    .select("*")
    .eq("auth_user_id", user.id)
    .maybeSingle<Profile>();
  if (!profile2) return null;

  const { data: wallet2 } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", profile2.id)
    .maybeSingle<Wallet>();
  if (!wallet2) return null;

  return {
    authUserId: user.id,
    email: user.email ?? null,
    emailConfirmed: Boolean(user.email_confirmed_at),
    profile: profile2,
    wallet: wallet2,
  };
}

/** Reads the caller's auth user without loading the profile. Used by webhooks/cron. */
export async function getAuthUser(): Promise<User | null> {
  const caller = await resolveCaller();
  return caller?.user ?? null;
}
