import type { Metadata } from "next";
import Link from "next/link";
import { isAdmin } from "@/lib/admin/auth";
import { logout } from "./login/actions";

export const metadata: Metadata = {
  title: "Admin — The Way To English",
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const loggedIn = await isAdmin();
  return (
    <div className="admin">
      <header className="topbar">
        <Link href="/admin" className="admin-brand">
          The Way To English · <span>Admin do currículo</span>
        </Link>
        {loggedIn && (
          <form action={logout}>
            <button type="submit" className="admin-button is-small is-ghost">
              Sair
            </button>
          </form>
        )}
      </header>
      <main className="admin-main">{children}</main>
    </div>
  );
}
