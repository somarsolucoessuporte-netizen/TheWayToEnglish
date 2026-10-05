import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, ADMIN_SESSION_SECONDS, adminPassword, checkPassword, createSessionToken } from "@/lib/admin/session";

// Plain HTML form POST from /admin/login — deliberately not a Server Action:
// an action ID is tied to one build, so a login page left open across a
// redeploy failed with "Server Action not found". A fixed URL has no skew.
export async function POST(request: NextRequest) {
  const back = (error: string) => NextResponse.redirect(new URL(`/admin/login?erro=${error}`, request.url), 303);

  if (!adminPassword()) return back("desativado");
  const form = await request.formData().catch(() => null);
  const attempt = String(form?.get("password") ?? "");
  if (!checkPassword(attempt)) {
    await new Promise((resolve) => setTimeout(resolve, 800)); // slows down guessing
    return back("senha");
  }

  const response = NextResponse.redirect(new URL("/admin", request.url), 303);
  response.cookies.set(ADMIN_COOKIE, createSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/admin",
    maxAge: ADMIN_SESSION_SECONDS,
  });
  return response;
}
