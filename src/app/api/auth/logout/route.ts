import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ok, runApi } from "@/lib/api/response";

/** POST /api/auth/logout — clears the Supabase session cookies server-side. */
export async function POST() {
  return runApi(async () => {
    const supabase = await createServerSupabaseClient();
    await supabase.auth.signOut();
    return ok({ message: "Signed out." });
  });
}
