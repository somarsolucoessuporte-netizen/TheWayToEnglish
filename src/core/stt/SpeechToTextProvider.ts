export type STTEvent = "partial" | "final" | "error" | "end" | "transcribing" | "amplitude";

/** Payload of the "final" event. `detectedLanguage` is best-effort and
 * provider-specific — e.g. WhisperSTTProvider reports what Groq detected;
 * BrowserSTTProvider omits it (it only recognizes in the language it was
 * told to listen for, it doesn't detect one). */
export interface SttResult {
  transcript: string;
  detectedLanguage?: string;
}

export interface SpeechToTextProvider {
  /** lang is a BCP-47 tag (e.g. "en-US", "pt-BR"). Defaults to the
   * provider's own default when omitted. Providers that auto-detect
   * language (e.g. WhisperSTTProvider) may ignore this. */
  start(lang?: string): Promise<void>;
  /** Stops listening and resolves with the final transcript. */
  stop(): Promise<string>;
  /**
   * "final" fires (with an SttResult payload) whenever a transcript is
   * ready — including when the underlying engine stops itself after
   * detecting silence (e.g. SpeechRecognition with continuous:false), not
   * only after an explicit stop() call. Callers that need to react to a
   * transcript arriving should listen for "final" rather than depending
   * on stop()'s return value, which only resolves for stop() calls that
   * actually happen.
   * "end" fires whenever listening has stopped for any reason, so UI
   * state can reset even when the user said nothing.
   * "transcribing" fires for providers with an upload/processing gap
   * between "stopped recording" and "transcript ready" (e.g. a batch STT
   * provider that uploads the whole recording) — never fires for engines
   * that transcribe live and have no such gap.
   * "amplitude" fires repeatedly while listening (payload: a real-time
   * RMS number, roughly 0-1) for providers with a real energy-based VAD
   * (e.g. WhisperSTTProvider) — used to drive a genuine sound-wave
   * indicator in the UI instead of a canned animation. Never fires for
   * providers without one (e.g. BrowserSTTProvider).
   */
  on(event: STTEvent, cb: (payload: unknown) => void): () => void;
}
