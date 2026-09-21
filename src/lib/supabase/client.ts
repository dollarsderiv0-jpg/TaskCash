"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getPublicSupabaseConfig } from "@/lib/env";

/**
 * Browser client. It only ever holds the publishable (anon) key — the
 * service-role key is never available in client code, and every financial
 * read/write in the UI goes through our own API routes anyway.
 */
export function createBrowserSupabaseClient() {
  const { url, key } = getPublicSupabaseConfig();
  return createBrowserClient(url, key);
}
