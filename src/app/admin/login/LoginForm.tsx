"use client";

import { useActionState } from "react";
import { login } from "./actions";

export function LoginForm() {
  const [error, action, pending] = useActionState(login, null);
  return (
    <form action={action} className="admin-form">
      <label>
        <span>Senha</span>
        <input type="password" name="password" autoComplete="current-password" required autoFocus />
      </label>
      <div className="admin-actions">
        <button type="submit" className="admin-button" disabled={pending}>
          {pending ? "Entrando…" : "Entrar"}
        </button>
      </div>
      {error && (
        <div className="admin-result is-error" role="alert">
          <strong>{error}</strong>
        </div>
      )}
    </form>
  );
}
