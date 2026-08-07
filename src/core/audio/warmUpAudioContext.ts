function getAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

/**
 * Purely informational — see components/DebugPanel.tsx and page.tsx's
 * runBoot. Used to be a hard boot-gate step (waiting for a fresh
 * AudioContext to report "suspended" — the ONLY state it can ever report
 * before a real user gesture resumes one), which is exactly why the
 * splash used to hang forever on every iPhone: iOS Safari never resumes a
 * context on its own, and nobody's touched anything yet during boot. Now
 * this just creates a throwaway context long enough to read its real
 * initial state for the debug panel, then closes it — nothing in the app
 * depends on this specific instance surviving. WhisperSTTProvider and
 * playCorrectSound each create their own AudioContext when actually
 * needed (mic recording, a praise sound), independent of this one.
 */
export function checkAudioContextState(): string {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return "indisponível neste navegador";
  try {
    const ctx = new Ctor();
    const state = ctx.state;
    void ctx.close();
    return state;
  } catch (err) {
    return `verificação falhou: ${err instanceof Error ? err.message : String(err)}`;
  }
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
 * triggered. Unlocks both tracks WebKit gates separately: a throwaway
 * AudioContext (resume + a silent buffer played through it, then closed —
 * this instance isn't shared with the rest of the app, see
 * checkAudioContextState's doc comment) and plain <audio> elements (a
 * silent WAV blob's play/pause).
 */
export function unlockAudioForIOS(): void {
  const Ctor = getAudioContextCtor();
  if (Ctor) {
    try {
      const ctx = new Ctor();
      void ctx.resume();
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
      // Its only job was to run through resume()+start() once, inside this
      // gesture — nothing downstream needs it to stick around.
      window.setTimeout(() => void ctx.close(), 1000);
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
