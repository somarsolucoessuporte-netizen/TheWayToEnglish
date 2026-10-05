// Shown instead of a bare "This page couldn't load" when the admin can't
// reach Supabase — only after requireAdmin(), and never with key values:
// just which variables are missing plus the error message.

const REQUIRED_ENV = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const e = error as { message: unknown; code?: unknown; hint?: unknown };
    return [e.code, e.message, e.hint].filter(Boolean).join(" — ");
  }
  return String(error);
}

export function DataError({ error }: { error: unknown }) {
  console.error("[admin] Supabase read failed:", error);
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  return (
    <div className="admin-result is-error" role="alert">
      <strong>Não consegui ler o Supabase.</strong>
      <ul>
        <li>{describe(error)}</li>
        {missing.length > 0 && <li>Variáveis ausentes no servidor: {missing.join(", ")}</li>}
        <li>Variáveis novas na Vercel só valem depois de um Redeploy.</li>
      </ul>
    </div>
  );
}
