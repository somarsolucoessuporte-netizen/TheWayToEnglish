import type { SpeechEvent, SpeechOptions, SpeechProvider } from "./SpeechProvider";

type Listener = (e?: unknown) => void;

/** Slower-than-normal playback speed used for the "hear it, repeat it"
 * pronunciation model (see SpeechProvider.speakSlow) — passed straight
 * through to OpenAI's TTS `speed` parameter, not a client-side
 * playbackRate hack, so it stays crisp instead of sounding pitched down. */
const SLOW_SPEED = 0.65;

/**
 * Speaks by requesting audio from /api/tts (a server route that holds the
 * OPENAI_API_KEY secret and calls OpenAI's /v1/audio/speech) and playing
 * the returned MP3 through a real <audio> element.
 */
export class OpenAITTSProvider implements SpeechProvider {
  private audio: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;
  private speaking = false;
  /** Resolver for the in-flight speakAtSpeed() promise, if any — cancel()
   * calls this so an interruption (orchestrator.reset() / forceAnnounce())
   * can't leave a previous speak() call awaiting forever on an "ended"
   * event that a paused, abandoned <audio> element will never fire. */
  private pendingResolve: (() => void) | null = null;
  private readonly listeners: Record<SpeechEvent, Set<Listener>> = {
    start: new Set(),
    end: new Set(),
    error: new Set(),
  };

  async speak(text: string, _opts: SpeechOptions = {}): Promise<void> {
    return this.speakAtSpeed(text, 1.0);
  }

  /** See SpeechProvider.speakSlow. */
  async speakSlow(text: string, _opts: SpeechOptions = {}): Promise<void> {
    return this.speakAtSpeed(text, SLOW_SPEED);
  }

  private async speakAtSpeed(text: string, speed: number): Promise<void> {
    this.cancel();

    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, speed }),
      });
      if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);

      const arrayBuffer = await response.arrayBuffer();
      const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      console.log("[TTS] blob criado:", url);
      const audio = new Audio(url);
      console.log("[TTS] audio criado:", audio);
      this.audio = audio;
      this.currentUrl = url;

      await new Promise<void>((resolve) => {
        // Wrapping resolve so cancel() can also settle this promise (and
        // clear the ref) if it interrupts before "ended"/"error" ever fire.
        const finish = () => {
          this.pendingResolve = null;
          resolve();
        };
        this.pendingResolve = finish;

        // "playing" fires when the browser actually has audible frames
        // ready to render — NOT "play" (fires as soon as .play() lifts
        // the element out of paused state, which can happen before enough
        // of a freshly-fetched MP3 blob is decoded) and NOT
        // "canplay"/"loadeddata" (fire even earlier, before playback has
        // been requested at all). The avatar's mouth animation is gated on
        // this "start" event (see orchestrator's constructor) specifically
        // so it can never start moving before sound is actually audible.
        audio.onplaying = () => {
          this.speaking = true;
          this.emit("start");
        };
        audio.onended = () => {
          this.speaking = false;
          this.emit("end");
          this.revokeCurrentUrl();
          finish();
        };
        audio.onerror = (event) => {
          console.error("[TTS] erro audio:", event);
          this.speaking = false;
          this.emit("error", event);
          this.revokeCurrentUrl();
          finish();
        };
        void audio.play().catch((err) => {
          this.emit("error", err);
          finish();
        });
      });
    } catch (err) {
      // Explicit, not silent: log here AND rethrow so the orchestrator's
      // existing error handling (ERROR state, error toast) actually fires
      // instead of the conversation quietly proceeding as if nothing
      // happened — this used to only emit locally, which nothing outside
      // this class was guaranteed to surface.
      console.error("[OpenAI TTS] erro:", err);
      this.emit("error", err);
      throw err;
    }
  }

  cancel(): void {
    if (this.audio) {
      // Detach handlers first — an abandoned <audio> element must never
      // fire "playing"/"ended"/"error" against a blob URL cancel() is
      // about to revoke out from under it.
      this.audio.onplaying = null;
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio.currentTime = 0;
    }
    this.revokeCurrentUrl();
    this.speaking = false;
    // Settle any speakAtSpeed() call still awaiting "ended"/"error" — a
    // paused, abandoned element will never fire either, so without this
    // the caller (e.g. orchestrator.handleUserMessage) would hang forever.
    if (this.pendingResolve) {
      const finish = this.pendingResolve;
      this.pendingResolve = null;
      finish();
    }
  }

  private revokeCurrentUrl(): void {
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  on(event: SpeechEvent, cb: Listener): () => void {
    this.listeners[event].add(cb);
    return () => this.listeners[event].delete(cb);
  }

  /** Real <audio> element playing the current utterance. */
  getAudioElement(): HTMLAudioElement | null {
    return this.audio;
  }

  private emit(event: SpeechEvent, payload?: unknown): void {
    for (const cb of this.listeners[event]) cb(payload);
  }
}
