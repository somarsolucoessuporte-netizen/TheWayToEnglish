import type { CharacterState } from "../character-state-machine/stateMachine";

type AvatarListener = (state: CharacterState) => void;

/**
 * Minimal state relay between the conversation orchestrator and the Avatar
 * component. The orchestrator calls setState() on every CharacterState
 * transition (see its stateMachine.subscribe hook in the constructor);
 * Avatar.tsx subscribes and renders accordingly — idle.png for every
 * state except "speaking", which shows the looping speaking.mp4 instead
 * (see Avatar.tsx for exactly how play/pause is driven by this).
 *
 * Deliberately dumb: no sprite keys, no amplitude analysis, no per-state
 * transition timing — the previous 9-PNG crossfade system (see
 * public/avatar/_old_sprites/) needed all of that to fake a talking mouth
 * from static frames. A real video doesn't; it just needs to know whether
 * it should be playing right now.
 */
export class AvatarEngine {
  private currentState: CharacterState = "idle";
  private readonly listeners = new Set<AvatarListener>();

  subscribe(listener: AvatarListener): () => void {
    this.listeners.add(listener);
    listener(this.currentState);
    return () => this.listeners.delete(listener);
  }

  getCurrentState(): CharacterState {
    return this.currentState;
  }

  /** Public contract: tell the avatar which character state is active. */
  setState(state: CharacterState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    for (const listener of this.listeners) listener(state);
  }

  destroy(): void {
    this.listeners.clear();
  }
}
