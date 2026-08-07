import type { CharacterState } from "../character-state-machine/stateMachine";

/** The 5 states that actually have a video (see public/avatar/) — every
 * CharacterState maps onto one of these, several-to-one (see
 * getVideoState). "correction" and "error" don't have dedicated clips
 * yet, so they fall back to idle — a deliberate placeholder, not a bug. */
export type AvatarVideoState = "idle" | "listening" | "thinking" | "speaking" | "praise";

type AvatarListener = (state: AvatarVideoState) => void;
type AudioDurationListener = (durationSec: number | null) => void;
type SpeechSegmentEndedListener = () => void;

/**
 * Minimal state relay between the conversation orchestrator and the Avatar
 * component: translates the state machine's CharacterState (plus the
 * separate "transcribing" flag — see setTranscribing) into which of the 5
 * avatar videos should be showing. The orchestrator calls setState() on
 * every CharacterState transition (see its stateMachine.subscribe hook in
 * the constructor) and page.tsx forwards onTranscribing() here too;
 * Avatar.tsx just renders whatever getVideoState() says.
 *
 * Deliberately dumb: no sprite keys, no amplitude analysis, no per-state
 * transition timing — Avatar.tsx owns all of that (crossfade opacity,
 * praise's one-shot play). This class only ever answers "which state is
 * this, right now."
 */
export class AvatarEngine {
  private currentState: CharacterState = "idle";
  private transcribing = false;
  private readonly listeners = new Set<AvatarListener>();
  private readonly audioDurationListeners = new Set<AudioDurationListener>();
  private readonly speechSegmentEndedListeners = new Set<SpeechSegmentEndedListener>();

  subscribe(listener: AvatarListener): () => void {
    this.listeners.add(listener);
    listener(this.getVideoState());
    return () => this.listeners.delete(listener);
  }

  /** Which of the 5 avatar videos should be visible right now — see
   * AvatarVideoState's doc comment for the "correction"/"error" fallback
   * and this class's doc comment for the transcribing override. */
  getVideoState(): AvatarVideoState {
    // A batch STT provider's upload/transcription gap (see
    // orchestrator.onTranscribing) still reports CharacterState
    // "listening" — the mic recording is technically over, the tutor is
    // just waiting on a transcript back, which reads visually as
    // "thinking" rather than "still listening for more".
    if (this.currentState === "listening" && this.transcribing) return "thinking";
    switch (this.currentState) {
      case "idle":
      case "listening":
      case "thinking":
      case "speaking":
      case "praise":
        return this.currentState;
      case "correction":
      case "error":
      default:
        return "idle";
    }
  }

  /** Public contract: tell the avatar which character state is active. */
  setState(state: CharacterState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    this.notify();
  }

  /** See getVideoState's transcribing override — page.tsx forwards
   * orchestrator.onTranscribing() here alongside its own React state. */
  setTranscribing(transcribing: boolean): void {
    if (transcribing === this.transcribing) return;
    this.transcribing = transcribing;
    // Only "listening" is ever affected by this flag — no-op notify
    // otherwise (nothing downstream would actually change).
    if (this.currentState === "listening") this.notify();
  }

  /**
   * Called by the orchestrator (see its speech.on("start", ...) handler)
   * the instant a new TTS audio segment actually starts playing, with that
   * segment's real duration in seconds (or null if unavailable) — used by
   * Avatar.tsx to size the speaking clip's manual loop count for THIS
   * segment (see public/avatar's smart-loop rule: a 3-part correction
   * drill fires this once per part, each with its own duration, all while
   * the character state stays "speaking" continuously throughout).
   */
  setSpeechAudioDuration(durationSec: number | null): void {
    for (const cb of this.audioDurationListeners) cb(durationSec);
  }

  onSpeechAudioDuration(cb: AudioDurationListener): () => void {
    this.audioDurationListeners.add(cb);
    return () => this.audioDurationListeners.delete(cb);
  }

  /**
   * Called by the orchestrator (see its speech.on("end"/"error", ...)
   * handlers) the instant the CURRENT audio segment's real playback stops
   * — fires once per speak() call, not once per multi-part turn (compare
   * setState("idle"), which only happens after the WHOLE turn's SPEECH_END).
   * Avatar.tsx uses this to snap the speaking clip to a neutral frame
   * instead of riding out a mostly-empty final loop in silence.
   */
  notifySpeechSegmentEnded(): void {
    for (const cb of this.speechSegmentEndedListeners) cb();
  }

  onSpeechSegmentEnded(cb: SpeechSegmentEndedListener): () => void {
    this.speechSegmentEndedListeners.add(cb);
    return () => this.speechSegmentEndedListeners.delete(cb);
  }

  private notify(): void {
    const videoState = this.getVideoState();
    console.log("[avatar] estado ->", videoState);
    for (const listener of this.listeners) listener(videoState);
  }

  destroy(): void {
    this.listeners.clear();
  }
}
