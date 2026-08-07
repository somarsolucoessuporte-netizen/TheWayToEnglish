"use client";

import { branding } from "@/app-config/branding";

/**
 * Full-screen boot gate shown while the avatar assets, TTS warm-up,
 * AudioContext and /api/chat health check are still settling (see the
 * boot sequence in app/page.tsx) — the avatar and chat never mount before
 * ALL of that finishes, so they can't try to start against half-loaded
 * assets or a cold API. "timeout" is a distinct status from "error": it
 * means boot was still in progress past the 8s safety net, not that any
 * individual step definitively failed.
 */
export function LoadingScreen({
  status,
  fadingOut,
  progressPct = 0,
  statusText,
}: {
  status: "loading" | "error" | "timeout";
  fadingOut: boolean;
  progressPct?: number;
  statusText?: string;
}) {
  return (
    <div className={`loading-screen${fadingOut ? " loading-screen-fadeout" : ""}`}>
      <div className="loading-logo">{branding.companyName}</div>
      <div className="loading-subtitle">{branding.productName}</div>
      {status === "loading" ? (
        <div className="loading-progress">
          <div className="loading-progress-track">
            <div className="loading-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="loading-progress-text" aria-live="polite">
            {statusText}
          </div>
        </div>
      ) : (
        <>
          <p className="loading-error-text">
            {status === "timeout" ? branding.copy.bootTimeoutText : branding.copy.bootErrorText}
          </p>
          {/* A full reload, not a re-run of the in-memory boot promise —
              if the app got this far into a broken/slow state, starting
              the JS runtime over is the more reliable recovery than
              trusting its own retry logic. */}
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            {branding.copy.bootRetryButton}
          </button>
        </>
      )}
    </div>
  );
}
