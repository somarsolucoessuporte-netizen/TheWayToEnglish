import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/admin/auth";

const ERRORS: Record<string, string> = {
  senha: "Senha incorreta.",
  desativado: "Admin desativado: ADMIN_PASSWORD não está configurada no servidor.",
};

export default async function AdminLoginPage({ searchParams }: { searchParams: Promise<{ erro?: string | string[] }> }) {
  if (await isAdmin()) redirect("/admin");
  const { erro } = await searchParams;
  const error = typeof erro === "string" ? ERRORS[erro] : undefined;

  // Plain form POST to a route handler (see api/admin/login/route.ts) — works
  // without JS and survives redeploys.
  return (
    <div className="admin-card admin-login">
      <h1 className="admin-title">Entrar</h1>
      <form method="post" action="/api/admin/login" className="admin-form">
        <label>
          <span>Senha</span>
          <input type="password" name="password" autoComplete="current-password" required autoFocus />
        </label>
        <div className="admin-actions">
          <button type="submit" className="admin-button">
            Entrar
          </button>
        </div>
        {error && (
          <div className="admin-result is-error" role="alert">
            <strong>{error}</strong>
          </div>
        )}
      </form>
    </div>
  );
}
