import { redirect } from "next/navigation";
import { ApiError } from "@/lib/api/errors";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { getSessionContext, getSessionUser, type SessionContext, type SessionUser } from "@/lib/auth/session";
import { logger } from "@/lib/logger";

/**
 * Authorization happens here, on the server, every time.
 *
 * Nothing in this file can be influenced by a client-provided `role`,
 * `admin` flag or `balance`. The database is the only source of truth.
 */

export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    throw new ApiError("UNAUTHORIZED", "Please sign in to continue.", 401);
  }
  return user;
}

/**
 * As `requireSessionUser()`, but also returns the client that carries the
 * caller's credentials.
 *
 * For endpoints whose work happens inside a SECURITY DEFINER function that
 * reads `auth.uid()` to decide *whose* wallet it credits. The service-role
 * client carries no user token, so `auth.uid()` is null inside such a function
 * and it refuses — which is exactly how `/api/redeem` came to answer 500 for
 * every valid code while the code itself was never the problem.
 *
 * The authorisation is identical to `requireSessionUser()`; only the client that
 * carries the already-established identity differs, and it is the caller's own.
 */
export async function requireSessionUserAndClient(): Promise<SessionContext> {
  const context = await getSessionContext();
  if (!context) {
    throw new ApiError("UNAUTHORIZED", "Please sign in to continue.", 401);
  }
  return context;
}

/**
 * Admin authorization. The role is re-read from the database on every request
 * rather than taken from a JWT claim, so revoking admin access takes effect
 * immediately.
 */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireSessionUser();

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from("profiles")
    .select("role, status")
    .eq("id", user.profile.id)
    .maybeSingle<{ role: string; status: string }>();

  if (error) {
    logger.error("admin_authorization_failed", { userId: user.profile.id, error: error.message });
    throw new ApiError("FORBIDDEN", "You do not have access to this resource.", 403);
  }

  const isAdmin = data?.role === "ADMIN" || data?.role === "SUPER_ADMIN";
  if (!isAdmin || data?.status !== "ACTIVE") {
    logger.warn("admin_access_denied", { userId: user.profile.id, role: data?.role });
    throw new ApiError("FORBIDDEN", "You do not have access to this resource.", 403);
  }

  return { ...user, profile: { ...user.profile, role: data.role as SessionUser["profile"]["role"] } };
}

/* -------------------------------------------------------------------------- */
/* Email verification                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The verification policy, in one place, so it cannot drift between the API
 * guard, the page guard and the documentation.
 *
 * Where verification is REQUIRED (money moves, or is earned):
 *   /dashboard/deposit, /dashboard/withdraw, /dashboard/watch, /dashboard/referrals
 * Where an unverified account is ALLOWED to look around:
 *   /dashboard, /dashboard/wallet, /dashboard/notifications, /dashboard/profile
 *
 * Looking at a zero balance costs nothing and helps nobody; creating value or
 * moving it is what a throwaway account is for. So the gate sits on the second
 * list, and the plain dashboard shows a banner instead of a wall.
 *
 * `emailConfirmed` comes from `user.email_confirmed_at` on the Supabase auth
 * record — a value only the auth service writes. It is never read from a
 * request body, a cookie, or a client-supplied flag.
 */
export const VERIFICATION_REQUIRED_PREFIXES = [
  "/dashboard/deposit",
  "/dashboard/withdraw",
  "/dashboard/watch",
  "/dashboard/referrals",
] as const;

export function requiresVerifiedEmail(pathname: string): boolean {
  return VERIFICATION_REQUIRED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * API guard for the routes behind verification.
 *
 * Throws 403 EMAIL_NOT_VERIFIED rather than 401: the caller IS authenticated,
 * and telling them to sign in again would send them in a circle.
 */
export async function requireVerifiedUser(scope: string): Promise<SessionUser> {
  const user = await requireSessionUser();
  if (user.emailConfirmed) return user;

  logger.warn("email_verification_required", {
    scope,
    userId: user.profile.id,
  });

  throw new ApiError(
    "EMAIL_NOT_VERIFIED",
    "Verify your email address to continue.",
    403,
    { email: user.email ?? null },
  );
}

/* -------------------------------------------------------------------------- */
/* Page-level guards (redirect instead of throwing)                           */
/* -------------------------------------------------------------------------- */

export async function guardPage(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/dashboard");
  return user;
}

export async function guardAdminPage(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/admin");

  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("profiles")
    .select("role, status")
    .eq("id", user.profile.id)
    .maybeSingle<{ role: string; status: string }>();

  const isAdmin = data?.role === "ADMIN" || data?.role === "SUPER_ADMIN";
  if (!isAdmin || data?.status !== "ACTIVE") {
    // 404-style redirect: do not confirm that /admin exists to non-admins.
    redirect("/dashboard");
  }

  return user;
}

/**
 * Page guard for the routes behind verification.
 *
 * `next` is preserved so the user lands where they intended once they confirm,
 * and `/verify-email` itself is never a target — that is what would make the
 * redirect loop endless.
 */
export async function guardVerifiedPage(pathname: string): Promise<SessionUser> {
  const user = await guardPage();
  if (user.emailConfirmed) return user;

  const target = pathname.startsWith("/") ? pathname : "/dashboard";
  redirect(`/verify-email?next=${encodeURIComponent(target)}`);
}

export function isAdminRole(role: string | null | undefined): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}
