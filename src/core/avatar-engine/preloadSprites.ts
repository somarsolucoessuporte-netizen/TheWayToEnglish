import { ALL_SPRITE_KEYS, frameFor } from "./spriteMap";

/**
 * Preloads all 9 avatar sprite PNGs via Image() so the browser has already
 * decoded every pose before the avatar ever mounts — used by the app's
 * boot loading gate (see app/page.tsx) to avoid the avatar's first frame
 * flashing in mid-download. Resolves once every image has either loaded or
 * failed; never rejects and never hangs on a single broken asset.
 */
export function preloadAvatarSprites(): Promise<void> {
  const loads = ALL_SPRITE_KEYS.map(
    (key) =>
      new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => resolve();
        img.src = frameFor(key).src;
      })
  );
  return Promise.all(loads).then(() => undefined);
}
