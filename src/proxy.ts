import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, isValidSessionToken } from "@/lib/admin/session";

// Optimistic gate for /admin: no valid session cookie → /admin/login. The
// real check is requireAdmin() inside every admin page and Server Action
// (see lib/admin/auth.ts); this just keeps the redirect in one place.
export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/admin/login") return NextResponse.next();
  if (isValidSessionToken(request.cookies.get(ADMIN_COOKIE)?.value)) return NextResponse.next();
  return NextResponse.redirect(new URL("/admin/login", request.url));
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
