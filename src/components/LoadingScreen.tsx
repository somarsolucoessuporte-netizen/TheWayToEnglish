"use client";

import { branding } from "@/app-config/branding";

/**
 * Full-screen boot gate shown while the avatar sprites, TTS voices and
 * /api/chat health check are still settling (see the boot sequence in
 * app/page.tsx) — the avatar and chat never mount before that finishes, so
 * they can't try to start against half-loaded assets or a cold API.
 */
export function LoadingScreen({
  status,
  fadingOut,
  onRetry,
}: {
  status: "loading" | "error";
  fadingOut: boolean;
  onRetry: () => void;
}) {
  return (
    <div className={`loading-screen${fadingOut ? " loading-screen-fadeout" : ""}`}>
      <div className="loading-logo">{branding.companyName}</div>
      {status === "loading" ? (
        <div className="loading-dots" aria-label="Carregando">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <>
          <p className="loading-error-text">Estamos com instabilidade. Tente novamente em instantes.</p>
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            Tentar novamente
          </button>
        </>
      )}
    </div>
  );
}
