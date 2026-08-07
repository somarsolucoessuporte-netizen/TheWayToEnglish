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
  /**
   * Escape hatch: forcibly tears down whatever this provider is doing
   * right now — regardless of which async step it's stuck in (permission
   * prompt, getUserMedia, an in-flight upload) — and guarantees "end"
   * fires so the caller can get back to idle. Used by the Falar button's
   * long-press reset (see orchestrator.forceReset / ForceSendButton) as a
   * safety net for a hang that slips past the provider's own internal
   * timeouts. Optional: a provider with nothing that can meaningfully
   * hang (e.g. BrowserSTTProvider, whose only async step is the
   * synchronous-ish native SpeechRecognition.start()) can omit this and
   * fall back to its own stop().
   */
  abort?(): void;
  /**
   * Tells the provider which words the current lesson cares about (see
   * app-config/curriculum's CurriculumLesson.vocabulary) so it can hint
   * its transcription toward them — e.g. WhisperSTTProvider appends this
   * to the /api/stt request's prompt (see that route), which measurably
   * cuts down on near-homophone mixups ("city"/"siege",
   * "Morocco"/"Marroko") for Brazilian-accented English. Optional: a
   * provider without a vocabulary-hinting mechanism (e.g.
   * BrowserSTTProvider, whose native SpeechRecognition has no such
   * concept) can omit this. Called once per lesson (see
   * orchestrator.startLesson) — pass [] to clear it.
   */
  setLessonVocabulary?(vocabulary: string[]): void;
}
