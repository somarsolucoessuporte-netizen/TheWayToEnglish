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
}: {
  status: "loading" | "error";
  fadingOut: boolean;
}) {
  return (
    <div className={`loading-screen${fadingOut ? " loading-screen-fadeout" : ""}`}>
      <div className="loading-logo">{branding.companyName}</div>
      <div className="loading-subtitle">{branding.productName}</div>
      {status === "loading" ? (
        <div className="loading-dots" aria-label="Carregando">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <>
          <p className="loading-error-text">
            ⚠️ Estamos com instabilidade.
            <br />
            Tente novamente em instantes.
          </p>
          {/* A full reload, not a re-run of the in-memory boot promise —
              if the app got this far into a broken state, starting the JS
              runtime over is the more reliable recovery than trusting its
              own retry logic. */}
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Tentar novamente
          </button>
        </>
      )}
    </div>
  );
}
