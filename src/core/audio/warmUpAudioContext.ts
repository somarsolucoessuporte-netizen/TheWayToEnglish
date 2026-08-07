/**
 * Creates and immediately suspends an AudioContext so the browser's audio
 * subsystem has already spun up (driver/hardware init on some platforms
 * carries real first-time latency) before the app actually needs one — for
 * the STT VAD's analyser (see WhisperSTTProvider). Call once at app mount
 * and hold onto the returned context for the page's lifetime;
 * letting it get garbage-collected can undo the warm-up on some browsers.
 * Returns null if AudioContext isn't available at all (SSR, unsupported
 * browser) rather than throwing.
 */
export function warmUpAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioContextCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return null;

  const ctx = new AudioContextCtor();
  void ctx.suspend();
  return ctx;
}

/**
 * Boot-gate variant of warmUpAudioContext: creates the context and
 * resolves only once it's actually suspended, not just constructed — so
 * the loading screen's "voice ready" step (see app/page.tsx's runBoot)
 * reflects real readiness rather than a synchronous call that returned
 * before the browser's audio subsystem finished spinning up. Resolves
 * with null if AudioContext isn't available at all, same as
 * warmUpAudioContext.
 */
export async function ensureAudioContextReady(): Promise<AudioContext | null> {
  const ctx = warmUpAudioContext();
  if (!ctx) return null;
  try {
    await ctx.suspend();
  } catch {
    // Already suspended, or suspend() rejected because of the state it's
    // already in — either way the context itself exists and is usable.
  }
  return ctx;
}
