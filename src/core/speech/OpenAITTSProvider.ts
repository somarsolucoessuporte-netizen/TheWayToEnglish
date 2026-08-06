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
 * the returned MP3 through a real <audio> element — unlike
 * WebSpeechProvider, this gives the avatar engine real amplitude data
 * (via AnalyserNode, wired up by the orchestrator through getAudioElement)
 * instead of the synthetic talking-rhythm fallback.
 */
export class OpenAITTSProvider implements SpeechProvider {
  private audio: HTMLAudioElement | null = null;
  private speaking = false;
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
      const audio = new Audio(url);
      this.audio = audio;

      await new Promise<void>((resolve) => {
        audio.onplay = () => {
          this.speaking = true;
          this.emit("start");
        };
        audio.onended = () => {
          this.speaking = false;
          this.emit("end");
          URL.revokeObjectURL(url);
          resolve();
        };
        audio.onerror = (event) => {
          this.speaking = false;
          this.emit("error", event);
          URL.revokeObjectURL(url);
          resolve();
        };
        void audio.play().catch((err) => {
          this.emit("error", err);
          resolve();
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
      this.audio.pause();
      this.audio.currentTime = 0;
    }
    this.speaking = false;
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  on(event: SpeechEvent, cb: Listener): () => void {
    this.listeners[event].add(cb);
    return () => this.listeners[event].delete(cb);
  }

  /** Real <audio> element playing the current utterance — the avatar
   * engine connects an AnalyserNode to this for genuine amplitude-driven
   * mouth movement instead of the synthetic fallback. */
  getAudioElement(): HTMLAudioElement | null {
    return this.audio;
  }

  private emit(event: SpeechEvent, payload?: unknown): void {
    for (const cb of this.listeners[event]) cb(payload);
  }
}
