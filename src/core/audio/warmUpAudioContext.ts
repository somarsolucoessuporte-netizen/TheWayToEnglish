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

/**
 * Silent 1-sample WAV, built as raw bytes rather than a hardcoded base64
 * string so the format is easy to verify by eye — see unlockAudioForIOS.
 * 8-bit mono PCM, 8000Hz, one byte of silence (0x80 = midpoint = silence
 * for unsigned 8-bit audio).
 */
const SILENT_WAV_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x25, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00,
  0x00, 0x01, 0x00, 0x01, 0x00, 0x40, 0x1f, 0x00, 0x00, 0x40, 0x1f, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x64, 0x61,
  0x74, 0x61, 0x01, 0x00, 0x00, 0x00, 0x80,
]);

/**
 * iOS Safari only allows audio/video-with-sound playback after the page
 * has successfully played SOMETHING as a direct result of a user gesture —
 * once that happens, the whole page stays "unlocked" for the rest of the
 * session, including audio elements OpenAITTSProvider creates later on
 * turns with no gesture behind them at all. MUST be called synchronously
 * inside a real click handler, before any `await` in that handler — one
 * microtask tick is enough for iOS to stop considering it gesture-
 * triggered. Unlocks both tracks WebKit gates separately: the AudioContext
 * (resume + a silent buffer played through it) and plain <audio> elements
 * (a silent WAV blob's play/pause).
 */
export function unlockAudioForIOS(ctx: AudioContext | null): void {
  if (ctx) {
    void ctx.resume();
    try {
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch {
      // Best-effort — a failure here just means the first real TTS turn
      // pays for the unlock instead of it happening ahead of time.
    }
  }
  try {
    const url = URL.createObjectURL(new Blob([SILENT_WAV_BYTES], { type: "audio/wav" }));
    const audio = new Audio(url);
    audio
      .play()
      .then(() => audio.pause())
      .catch(() => {})
      .finally(() => URL.revokeObjectURL(url));
  } catch {
    // Same best-effort reasoning as above.
  }
}
