import type { SpeechEvent, SpeechOptions, SpeechProvider } from "./SpeechProvider";

type Listener = (e?: unknown) => void;

/**
 * Prepared but NOT activated by default (see app-config/providers.ts).
 * Speaks by requesting audio from /api/tts (a server route that holds the
 * ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID secret) and playing the returned
 * audio through a real <audio> element — which means, unlike
 * WebSpeechProvider, this one gives the avatar engine real amplitude data
 * instead of the synthetic fallback.
 */
export class ElevenLabsSpeechProvider implements SpeechProvider {
  private audio: HTMLAudioElement | null = null;
  private speaking = false;
  private readonly listeners: Record<SpeechEvent, Set<Listener>> = {
    start: new Set(),
    end: new Set(),
    error: new Set(),
  };

  async speak(text: string, _opts: SpeechOptions = {}): Promise<void> {
    this.cancel();

    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);

      const blob = await response.blob();
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
      this.emit("error", err);
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

  getAudioElement(): HTMLAudioElement | null {
    return this.audio;
  }

  private emit(event: SpeechEvent, payload?: unknown): void {
    for (const cb of this.listeners[event]) cb(payload);
  }
}
