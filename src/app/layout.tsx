import type { Metadata } from "next";
import "./globals.css";
import { branding } from "@/app-config/branding";

export const metadata: Metadata = {
  title: `${branding.productName} — ${branding.companyName}`,
  description: branding.tagline,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-br">
      <body>{children}</body>
    </html>
  );
}
