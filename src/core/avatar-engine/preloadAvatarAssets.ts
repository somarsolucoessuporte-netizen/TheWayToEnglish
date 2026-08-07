import { isIOS } from "@/core/utils/platform";
import type { AvatarVideoState } from "./AvatarEngine";

/** Every clip the avatar can show — see public/avatar/ and Avatar.tsx's
 * VIDEO_CLIPS. Preloaded together during the boot loading screen (see
 * page.tsx's runBoot) so switching between them is always an instant
 * crossfade, never a network wait mid-conversation. */
const AVATAR_VIDEO_STATES: AvatarVideoState[] = ["idle", "listening", "thinking", "speaking", "praise"];

export type AvatarPreloadStatus = "ok" | "error" | "timeout";

/** Human-readable names for HTMLMediaElement's numeric MediaError codes —
 * the DOM only gives you a number, and "código 4" means nothing on a
 * debug panel someone's reading off their own iPhone (see
 * components/DebugPanel.tsx). */
const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: "MEDIA_ERR_ABORTED",
  2: "MEDIA_ERR_NETWORK",
  3: "MEDIA_ERR_DECODE",
  4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
};

/**
 * Buffers one avatar clip up to "loadedmetadata" (dimensions/duration
 * known — NOT "canplaythrough", which iOS Safari never fires for a
 * <video> without a prior user gesture, hanging this promise on every
 * iPhone until its own timeout). Resolves once ready, or after
 * `timeoutMs` (a slow connection shouldn't hang the loading screen
 * forever) — never rejects, even on a genuine load error: Avatar.tsx's
 * own per-video onError handler is what falls back to idle for a clip
 * that's actually broken, not this preload refusing to settle. See
 * page.tsx's runBoot: this whole preload now runs in the background and
 * is NOT part of the boot gate that decides when the app is released —
 * each <video>'s own `poster` attribute (see Avatar.tsx) already covers
 * the gap between mount and its data actually arriving. `onStatus` is
 * purely for the debug panel's checklist — never affects timing/behavior.
 */
function preloadAvatarVideo(
  state: AvatarVideoState,
  timeoutMs = 6000,
  onStatus?: (status: AvatarPreloadStatus, detail?: string) => void
): Promise<void> {
  return new Promise<void>((resolve) => {
    const video = document.createElement("video");
    // iOS Safari won't buffer past the response headers without a user
    // gesture regardless of this hint, but asking for "auto" there just
    // wastes a bit of bandwidth guessing; every other browser preloads
    // faster with "auto".
    video.preload = isIOS() ? "metadata" : "auto";
    video.muted = true;
    video.playsInline = true;
    let done = false;
    const startedAt = performance.now();
    const finish = (status: AvatarPreloadStatus, detail?: string) => {
      if (done) return;
      done = true;
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
      onStatus?.(status, detail);
      resolve();
    };
    const onLoaded = () => finish("ok", `carregado em ${Math.round(performance.now() - startedAt)}ms`);
    const onError = () => {
      const err = video.error;
      const detail = err ? (MEDIA_ERROR_NAMES[err.code] ?? `código ${err.code}`) : "erro desconhecido";
      finish("error", detail);
    };
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("error", onError);
    video.src = `/avatar/${state}.mp4`;
    window.setTimeout(() => finish("timeout", `sem resposta em ${timeoutMs}ms`), timeoutMs);
  });
}

/** Preloads all 5 avatar clips in parallel — see preloadAvatarVideo.
 * Resolves once every one has settled (loaded, errored, or timed out).
 * `onStatus` (see DebugPanel) fires once per clip as it settles. */
export function preloadAllAvatarVideos(
  timeoutMs = 6000,
  onStatus?: (state: AvatarVideoState, status: AvatarPreloadStatus, detail?: string) => void
): Promise<void> {
  return Promise.all(
    AVATAR_VIDEO_STATES.map((state) =>
      preloadAvatarVideo(state, timeoutMs, (status, detail) => onStatus?.(state, status, detail))
    )
  ).then(() => undefined);
}
