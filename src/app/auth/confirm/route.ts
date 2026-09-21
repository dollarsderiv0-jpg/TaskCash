import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * GET /auth/confirm
 *
 * Completes email confirmation. Supabase's PKCE flow redirects here with a
 * `code`, which is exchanged for a session server-side. On success the database
 * trigger records `email_verified_at` and evaluates referral qualification.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/dashboard";

  if (!code) {
    return NextResponse.redirect(new URL("/login?confirm=missing", url.origin));
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    logger.warn("email_confirmation_failed", { message: error.message });
    return NextResponse.redirect(new URL("/login?confirm=failed", url.origin));
  }

  return NextResponse.redirect(new URL(next.startsWith("/") ? next : "/dashboard", url.origin));
}
