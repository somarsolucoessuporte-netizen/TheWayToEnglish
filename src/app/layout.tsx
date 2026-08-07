import type { Metadata, Viewport } from "next";
import "./globals.css";
import { branding } from "@/app-config/branding";

export const metadata: Metadata = {
  title: `${branding.productName} — ${branding.companyName}`,
  description: branding.tagline,
};

// viewportFit: "cover" is required for env(safe-area-inset-*) to resolve to
// anything but 0 — without it, the mobile drawer's safe-area padding (see
// globals.css) is a silent no-op on notched/gesture-bar iPhones.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
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
