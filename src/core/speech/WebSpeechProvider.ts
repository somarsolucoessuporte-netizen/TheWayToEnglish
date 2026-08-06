import type { SpeechEvent, SpeechOptions, SpeechProvider } from "./SpeechProvider";

type Listener = (e?: unknown) => void;

/**
 * Picks the best available English female voice, in priority order:
 * 1. "Samantha" (best female voice on Mac/iOS)
 * 2. "Google US English" (Chrome on Windows/Android)
 * 3. any en-US voice whose name suggests "female"/"woman"
 * 4. fallback: first en-US voice available
 */
function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  return (
    voices.find((v) => v.name === "Samantha") ||
    voices.find((v) => v.name.includes("Google US English")) ||
    voices.find(
      (v) => v.lang === "en-US" && (v.name.toLowerCase().includes("female") || v.name.toLowerCase().includes("woman"))
    ) ||
    voices.find((v) => v.lang === "en-US") ||
    null
  );
}

/**
 * getVoices() can return an empty list on first call in some browsers
 * (notably Chrome) until the async voice list finishes loading.
 */
function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const existing = window.speechSynthesis.getVoices();
  if (existing.length > 0) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const onVoicesChanged = () => {
      window.speechSynthesis.removeEventListener("voiceschanged", onVoicesChanged);
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener("voiceschanged", onVoicesChanged);
    // Some browsers never fire voiceschanged if voices were already
    // available synchronously by the time we get here — don't hang forever.
    setTimeout(() => {
      window.speechSynthesis.removeEventListener("voiceschanged", onVoicesChanged);
      resolve(window.speechSynthesis.getVoices());
    }, 1000);
  });
}

/**
 * Default TTS implementation: the browser's native speechSynthesis, tuned
 * for a female English tutor voice (see pickVoice) at a slightly slower,
 * slightly higher pitch — easier to follow when learning.
 * It exposes no <audio> element (the browser plays it outside any element
 * we can reach), so getAudioElement() returns null and the avatar engine
 * falls back to its synthetic talking rhythm.
 */
export class WebSpeechProvider implements SpeechProvider {
  private speaking = false;
  private cachedVoice: SpeechSynthesisVoice | null | undefined;
  private readonly listeners: Record<SpeechEvent, Set<Listener>> = {
    start: new Set(),
    end: new Set(),
    error: new Set(),
  };

  async speak(text: string, opts: SpeechOptions = {}): Promise<void> {
    if (!("speechSynthesis" in window)) {
      this.emit("error", "speechSynthesis unsupported");
      return;
    }

    window.speechSynthesis.cancel();

    if (this.cachedVoice === undefined) {
      this.cachedVoice = pickVoice(await loadVoices());
    }

    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = opts.lang ?? "en-US";
      utterance.rate = opts.rate ?? 0.9;
      utterance.pitch = opts.pitch ?? 1.1;
      utterance.volume = opts.volume ?? 1.0;
      if (this.cachedVoice) utterance.voice = this.cachedVoice;

      utterance.onstart = () => {
        this.speaking = true;
        this.emit("start");
      };
      utterance.onend = () => {
        this.speaking = false;
        this.emit("end");
        resolve();
      };
      utterance.onerror = (event) => {
        this.speaking = false;
        this.emit("error", event);
        resolve();
      };

      window.speechSynthesis.speak(utterance);
    });
  }

  cancel(): void {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
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
    return null;
  }

  private emit(event: SpeechEvent, payload?: unknown): void {
    for (const cb of this.listeners[event]) cb(payload);
  }
}
