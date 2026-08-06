import type { CharacterState } from "../character-state-machine/stateMachine";
import {
  type AmplitudeSource,
  createAnalyserAmplitudeSource,
  createSyntheticAmplitudeSource,
} from "./audioAmplitude";
import { type SpriteKey, speakingKeyForLevel, speakingLevelForAmplitude, spriteKeyForState } from "./spriteMap";

export interface Transition {
  durationMs: number;
  easing: string;
}

export interface AvatarEngineOptions {
  /** idle/listening/thinking/speaking/praise/correction/error swaps. */
  stateTransition?: Transition;
  /** speaking-closed/small/medium/wide swaps while speaking — much faster
   * than a state swap, or the mouth reads as blurry/laggy. */
  mouthTransition?: Transition;
  /** floor between actual mouth-sprite switches, regardless of how often
   * amplitude is sampled — without this the mouth flickers every frame. */
  mouthMinIntervalMs?: number;
  /** EMA alpha applied to sampled amplitude before it picks a mouth
   * sprite. Lower = more smoothing. */
  amplitudeSmoothingFactor?: number;
}

type AvatarListener = (activeKey: SpriteKey, transition: Transition) => void;

const DEFAULT_STATE_TRANSITION: Transition = { durationMs: 250, easing: "ease-in-out" };
// Human speech changes mouth shape ~4-6x/sec (~160-250ms apart). 130ms
// floor keeps switches in that range instead of a frenetic 12/sec; 100ms
// crossfade fits inside that floor so a frame fully fades in before the
// next switch fires — a 60ms fade with an 80ms floor never finished
// fading in, which is what read as flicker.
const DEFAULT_MOUTH_TRANSITION: Transition = { durationMs: 100, easing: "linear" };

/**
 * Drives which of the 9 always-mounted avatar sprites is visible. No SVG,
 * no layered rig — this MVP crossfades whole PNGs via opacity (see
 * components/Avatar.tsx, which mounts all 9 <img> once and never
 * unmounts them — this engine only ever toggles which key is "active").
 */
export class AvatarEngine {
  private currentKey: SpriteKey = "idle";
  private listeners = new Set<AvatarListener>();

  private audioElement: HTMLAudioElement | null = null;
  private amplitudeCache = new WeakMap<HTMLAudioElement, AmplitudeSource>();
  private amplitudeSource: AmplitudeSource | null = null;
  private smoothedAmplitude = 0;

  private speakingActive = false;
  private rafHandle: number | null = null;
  private currentMouthLevel = 0;
  private mouthSwitchCount = 0;
  private speakingStartedAt = 0;

  private readonly stateTransition: Transition;
  private readonly mouthTransition: Transition;
  private readonly mouthMinIntervalMs: number;
  private readonly amplitudeSmoothingFactor: number;

  constructor(options: AvatarEngineOptions = {}) {
    this.stateTransition = options.stateTransition ?? DEFAULT_STATE_TRANSITION;
    this.mouthTransition = options.mouthTransition ?? DEFAULT_MOUTH_TRANSITION;
    this.mouthMinIntervalMs = options.mouthMinIntervalMs ?? 130;
    this.amplitudeSmoothingFactor = options.amplitudeSmoothingFactor ?? 0.15;
  }

  subscribe(listener: AvatarListener): () => void {
    this.listeners.add(listener);
    listener(this.currentKey, this.stateTransition);
    return () => this.listeners.delete(listener);
  }

  getCurrentKey(): SpriteKey {
    return this.currentKey;
  }

  /** Public contract: tell the avatar which character state is active. */
  setState(state: CharacterState): void {
    if (state === "speaking") {
      if (!this.speakingActive) this.startSpeakingAnimation();
      return;
    }
    this.stopSpeakingAnimation();
    this.setSprite(spriteKeyForState(state), this.stateTransition);
  }

  /**
   * Public contract: give the engine the <audio> element currently playing
   * TTS output, if the active SpeechProvider exposes one. Pass null when
   * none is available (e.g. the default WebSpeechProvider) — the engine
   * falls back to a synthetic talking rhythm.
   */
  onAudioElement(audioEl: HTMLAudioElement | null): void {
    this.audioElement = audioEl;
    if (this.speakingActive) this.bindAmplitudeSource();
  }

  destroy(): void {
    this.stopSpeakingAnimation();
    this.listeners.clear();
  }

  private startSpeakingAnimation(): void {
    this.speakingActive = true;
    this.smoothedAmplitude = 0;
    this.currentMouthLevel = 0;
    this.mouthSwitchCount = 0;
    this.speakingStartedAt = performance.now();
    this.bindAmplitudeSource();

    let lastSwitchAt = 0;
    const loop = (t: number) => {
      if (!this.speakingActive) return;

      const raw = this.amplitudeSource ? this.amplitudeSource.sample() : 0;
      this.smoothedAmplitude += (raw - this.smoothedAmplitude) * this.amplitudeSmoothingFactor;

      if (t - lastSwitchAt >= this.mouthMinIntervalMs) {
        const nextLevel = speakingLevelForAmplitude(this.smoothedAmplitude, this.currentMouthLevel);
        if (nextLevel !== this.currentMouthLevel) {
          this.currentMouthLevel = nextLevel;
          lastSwitchAt = t;
          this.mouthSwitchCount++;
          this.setSprite(speakingKeyForLevel(nextLevel), this.mouthTransition);
        }
      }
      this.rafHandle = requestAnimationFrame(loop);
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  private stopSpeakingAnimation(): void {
    if (this.speakingActive && this.mouthSwitchCount > 0) {
      const elapsedSec = (performance.now() - this.speakingStartedAt) / 1000;
      const switchesPerSec = elapsedSec > 0 ? this.mouthSwitchCount / elapsedSec : 0;
      console.log("[AvatarEngine] mouth switch rate", {
        switches: this.mouthSwitchCount,
        elapsedSec: Number(elapsedSec.toFixed(2)),
        switchesPerSec: Number(switchesPerSec.toFixed(2)),
      });
    }

    this.speakingActive = false;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  private bindAmplitudeSource(): void {
    if (!this.audioElement) {
      this.amplitudeSource = createSyntheticAmplitudeSource();
      return;
    }
    const cached = this.amplitudeCache.get(this.audioElement);
    if (cached) {
      this.amplitudeSource = cached;
      return;
    }
    try {
      const source = createAnalyserAmplitudeSource(this.audioElement);
      this.amplitudeCache.set(this.audioElement, source);
      this.amplitudeSource = source;
    } catch {
      this.amplitudeSource = createSyntheticAmplitudeSource();
    }
  }

  private setSprite(key: SpriteKey, transition: Transition): void {
    if (key === this.currentKey) return;
    this.currentKey = key;
    for (const listener of this.listeners) listener(key, transition);
  }
}
