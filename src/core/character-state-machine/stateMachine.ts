export type PersistentState = "idle" | "listening" | "thinking" | "speaking";
export type TransientState = "praise" | "correction";
export type CharacterState = PersistentState | TransientState | "error";

export type StateEvent =
  | { type: "START_LISTENING" }
  | { type: "STOP_LISTENING" }
  | { type: "SPEECH_START" }
  | { type: "SPEECH_END" }
  | { type: "PRAISE" }
  | { type: "CORRECTION" }
  | { type: "ERROR" }
  | { type: "RESET" };

export interface CharacterStateMachineOptions {
  /** How long praise/correction hold before reverting, in ms. */
  transientDurationMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

type Listener = (state: CharacterState, prev: CharacterState) => void;

const PERSISTENT_TRANSITIONS: Partial<Record<PersistentState, Partial<Record<StateEvent["type"], PersistentState>>>> = {
  // STOP_LISTENING from idle covers typed (non-voice) messages: there's no
  // mic audio to stop, but it's the same semantic "a transcript is ready,
  // go think about it" transition.
  idle: { START_LISTENING: "listening", STOP_LISTENING: "thinking" },
  listening: { STOP_LISTENING: "thinking", START_LISTENING: "listening" },
  thinking: { SPEECH_START: "speaking" },
  speaking: { SPEECH_END: "idle" },
};

/**
 * Pure state machine for the avatar's expression/behavior. No React, no DOM,
 * no provider knowledge — just state + transitions, so it can be unit tested
 * in isolation and driven by the conversation orchestrator.
 */
export class CharacterStateMachine {
  private state: CharacterState = "idle";
  private previousPersistentState: PersistentState = "idle";
  private listeners = new Set<Listener>();
  private transientTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly transientDurationMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(options: CharacterStateMachineOptions = {}) {
    this.transientDurationMs = options.transientDurationMs ?? 1500;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  getState(): CharacterState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(event: StateEvent): void {
    switch (event.type) {
      case "PRAISE":
      case "CORRECTION":
        this.enterTransient(event.type === "PRAISE" ? "praise" : "correction");
        return;
      case "ERROR":
        this.clearTransientTimer();
        this.setState("error");
        return;
      case "RESET":
        this.clearTransientTimer();
        this.previousPersistentState = "idle";
        this.setState("idle");
        return;
      default:
        break;
    }

    // Persistent transitions only apply from a persistent (or error) state.
    // Praise/correction ignore drive events until they've reverted.
    if (this.state === "praise" || this.state === "correction") return;

    const from: PersistentState = this.state === "error" ? "idle" : (this.state as PersistentState);
    const next = PERSISTENT_TRANSITIONS[from]?.[event.type];
    if (next) {
      this.previousPersistentState = next;
      this.setState(next);
    }
  }

  private enterTransient(transient: TransientState): void {
    if (this.state !== "praise" && this.state !== "correction" && this.state !== "error") {
      this.previousPersistentState = this.state as PersistentState;
    }
    this.clearTransientTimer();
    this.setState(transient);
    this.transientTimer = this.setTimeoutFn(() => {
      this.transientTimer = null;
      this.setState(this.previousPersistentState);
    }, this.transientDurationMs);
  }

  private clearTransientTimer(): void {
    if (this.transientTimer !== null) {
      this.clearTimeoutFn(this.transientTimer);
      this.transientTimer = null;
    }
  }

  private setState(next: CharacterState): void {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    for (const listener of this.listeners) listener(next, prev);
  }
}
