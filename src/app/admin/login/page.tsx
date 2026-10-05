import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/admin/auth";
import { LoginForm } from "./LoginForm";

export default async function AdminLoginPage() {
  if (await isAdmin()) redirect("/admin");
  return (
    <div className="admin-card admin-login">
      <h1 className="admin-title">Entrar</h1>
      <LoginForm />
    </div>
  );
}
