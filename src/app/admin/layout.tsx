import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Admin — The Way To English",
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="admin">
      <header className="topbar">
        <Link href="/admin" className="admin-brand">
          The Way To English · <span>Admin do currículo</span>
        </Link>
      </header>
      <main className="admin-main">{children}</main>
    </div>
  );
}
