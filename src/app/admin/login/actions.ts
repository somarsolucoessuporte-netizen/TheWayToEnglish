"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_COOKIE, ADMIN_SESSION_SECONDS, adminPassword, checkPassword, createSessionToken } from "@/lib/admin/session";

export async function login(_prev: string | null, formData: FormData): Promise<string | null> {
  if (!adminPassword()) return "Admin desativado: ADMIN_PASSWORD não está configurada no servidor.";
  const attempt = String(formData.get("password") ?? "");
  if (!checkPassword(attempt)) {
    await new Promise((resolve) => setTimeout(resolve, 800)); // slows down guessing
    return "Senha incorreta.";
  }
  (await cookies()).set(ADMIN_COOKIE, createSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/admin",
    maxAge: ADMIN_SESSION_SECONDS,
  });
  redirect("/admin");
}

export async function logout(): Promise<void> {
  (await cookies()).delete({ name: ADMIN_COOKIE, path: "/admin" });
  redirect("/admin/login");
}
