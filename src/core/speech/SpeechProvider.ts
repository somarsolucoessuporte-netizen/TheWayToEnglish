export type SpeechEvent = "start" | "end" | "error";

export interface SpeechOptions {
  /** BCP-47 language tag, e.g. "en-US". */
  lang?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

/**
 * Anything capable of turning text into audible speech.
 *
 * The start/end events are not optional extras — the avatar engine relies on
 * them to enter and leave the "speaking" state. Without them the avatar's
 * mouth keeps moving after the audio actually stops.
 */
export interface SpeechProvider {
  speak(text: string, opts?: SpeechOptions): Promise<void>;
  cancel(): void;
  isSpeaking(): boolean;
  on(event: SpeechEvent, cb: (e?: unknown) => void): () => void;
  /**
   * Exposes the underlying <audio> element currently playing speech, if any.
   * Used by the avatar engine to drive mouth-shape selection from real
   * audio amplitude (AnalyserNode) instead of a blind timer.
   */
  getAudioElement?(): HTMLAudioElement | null;
  /**
   * Speaks `text` noticeably slower than normal (see OpenAITTSProvider's
   * 0.65x) — used for the "hear it, repeat it" pronunciation model after a
   * correction (see orchestrator) and the correction card's 🐢 button.
   * Optional: providers without real speed control (e.g. WebSpeechProvider)
   * can omit this; callers should fall back to a normal speak() when it's
   * missing rather than failing.
   */
  speakSlow?(text: string, opts?: SpeechOptions): Promise<void>;
}
