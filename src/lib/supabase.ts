import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Two Supabase clients:
//
// - createBrowserClient: anon key, safe in "use client" code. RLS is on with
//   no policies, so today it can read/write nothing — it exists for future
//   public features that get explicit policies.
// - createServiceClient: service_role key, bypasses RLS. API routes / server
//   code ONLY. SUPABASE_SERVICE_ROLE_KEY has no NEXT_PUBLIC_ prefix, so Next
//   never inlines it into a browser bundle; the window check turns an
//   accidental client-side call into a loud error instead of a silent
//   "key missing".

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function createBrowserClient(): SupabaseClient {
  // Literal process.env.NEXT_PUBLIC_* reads so Next inlines them client-side.
  return createClient(
    required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    required("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  );
}

let serviceClient: SupabaseClient | undefined;

export function createServiceClient(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("createServiceClient is server-only — never call it from client code");
  }
  serviceClient ??= createClient(
    required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    required("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY),
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  return serviceClient;
}
