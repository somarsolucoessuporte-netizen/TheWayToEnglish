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
