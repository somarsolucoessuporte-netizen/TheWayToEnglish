"use client";

/**
 * Fixed-position banner for orchestrator.onError messages (see page.tsx) —
 * the ONE place in the app where an async failure (a network timeout, a
 * denied mic permission, a TTS playback stall) actually becomes visible
 * to the student instead of only reaching the console. Previously
 * onError was console.error-only, which is exactly what made a real
 * failure indistinguishable from the app just sitting there frozen.
 *
 * Positioned as a fixed overlay (not inside either layout's own flow) so
 * one component works for both the desktop and mobile screens without
 * either needing its own copy.
 */
export function ErrorToast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="error-toast" role="status" aria-live="polite">
      {message}
    </div>
  );
}
