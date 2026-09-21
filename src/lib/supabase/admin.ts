import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/env";

/**
 * Service-role client. Bypasses RLS, so it may only be used inside
 * server-only code paths that have already authenticated and authorised the
 * caller themselves (API routes, admin routes, webhooks, cron).
 *
 * Never import this file from a Client Component.
 */
let cached: SupabaseClient | null = null;

export function createAdminSupabaseClient(): SupabaseClient {
  if (cached) return cached;
  const env = getServerEnv();

  cached = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.supabaseSecretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { "x-taskcash-client": "server-admin" },
    },
  });

  return cached;
}
