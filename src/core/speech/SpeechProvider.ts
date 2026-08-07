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
   * Exposes the underlying <audio> element currently playing speech, if
   * any. Used by the orchestrator's text-reveal sync (see
   * speakOnePartWithReveal) to read the real `.duration` and pace how
   * quickly words are revealed against it, instead of guessing.
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
  /**
   * Plays an already-fetched audio Blob directly, skipping the network
   * round trip a normal speak() call would make — used for the boot-time
   * greeting prefetch (see orchestrator.startLesson / page.tsx's runBoot),
   * where the audio for the tutor's opening line was already fetched
   * during the loading screen. Still fires the same "start"/"end" events
   * as a normal speak() call. Optional: providers without a fetch-based
   * pipeline (e.g. WebSpeechProvider, which calls the browser's built-in
   * synthesizer rather than fetching audio) can omit this; callers fall
   * back to a normal speak() when it's missing.
   */
  speakBlob?(blob: Blob): Promise<void>;
}
