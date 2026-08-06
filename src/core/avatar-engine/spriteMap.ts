import manifest from "../../../public/avatar/avatar-manifest.json";
import type { CharacterState } from "../character-state-machine/stateMachine";

export type SpriteKey =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking-closed"
  | "speaking-small"
  | "speaking-medium"
  | "speaking-wide"
  | "praise"
  | "correction";

export interface AvatarFrame {
  key: SpriteKey;
  src: string;
  width: number;
  height: number;
}

const MANIFEST = manifest as Record<SpriteKey, { w: number; h: number }>;

/**
 * Cache-buster for the sprite PNGs. `public/` assets share a URL with
 * whatever was last deployed at that path — browsers (and the dev server's
 * own Cache-Control: max-age=0-but-revalidate) can hold onto a stale image
 * across an art re-crop. Bump this whenever the files in public/avatar/
 * are regenerated.
 */
export const AVATAR_ASSET_VERSION = "3";

export const ALL_SPRITE_KEYS: SpriteKey[] = [
  "idle",
  "listening",
  "thinking",
  "speaking-closed",
  "speaking-small",
  "speaking-medium",
  "speaking-wide",
  "praise",
  "correction",
];

export function frameFor(key: SpriteKey): AvatarFrame {
  const dims = MANIFEST[key];
  return { key, src: `/avatar/${key}.png?v=${AVATAR_ASSET_VERSION}`, width: dims.w, height: dims.h };
}

/**
 * Maps a non-speaking character state to its sprite. "speaking" is handled
 * separately by speakingKeyForAmplitude, since it cycles between 4 frames.
 * "error" reuses the idle sprite per spec — no dedicated art for it.
 */
export function spriteKeyForState(state: Exclude<CharacterState, "speaking">): SpriteKey {
  switch (state) {
    case "idle":
    case "error":
      return "idle";
    case "listening":
      return "listening";
    case "thinking":
      return "thinking";
    case "praise":
      return "praise";
    case "correction":
      return "correction";
  }
}

const SPEAKING_FRAMES: SpriteKey[] = [
  "speaking-closed",
  "speaking-small",
  "speaking-medium",
  "speaking-wide",
];

/**
 * Hysteresis band per boundary: rising uses the higher threshold (harder to
 * go UP a mouth-openness level), falling uses a ~20% lower one (harder to
 * go back DOWN). Without this, amplitude hovering right at a boundary
 * (e.g. ~0.35) flips the sprite every single sample — reads as flicker.
 */
const RISING_THRESHOLDS = [0.12, 0.35, 0.65];
const FALLING_THRESHOLDS = [0.1, 0.28, 0.52];

/**
 * amplitude in [0,1] + the current mouth-openness level (0=closed..3=wide)
 * -> next level. Stateful on purpose — see hysteresis note above. Callers
 * own the state (AvatarEngine keeps it in `currentMouthLevel`).
 */
export function speakingLevelForAmplitude(amplitude: number, currentLevel: number): number {
  const clamped = Math.max(0, Math.min(1, amplitude));
  let level = currentLevel;
  while (level < SPEAKING_FRAMES.length - 1 && clamped >= RISING_THRESHOLDS[level]) level++;
  while (level > 0 && clamped < FALLING_THRESHOLDS[level - 1]) level--;
  return level;
}

export function speakingKeyForLevel(level: number): SpriteKey {
  return SPEAKING_FRAMES[level];
}
