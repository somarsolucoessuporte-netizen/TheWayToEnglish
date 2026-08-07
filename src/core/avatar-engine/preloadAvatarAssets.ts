import { isIOS } from "@/core/utils/platform";
import type { AvatarVideoState } from "./AvatarEngine";

/** Every clip the avatar can show — see public/avatar/ and Avatar.tsx's
 * VIDEO_CLIPS. Preloaded together during the boot loading screen (see
 * page.tsx's runBoot) so switching between them is always an instant
 * crossfade, never a network wait mid-conversation. */
const AVATAR_VIDEO_STATES: AvatarVideoState[] = ["idle", "listening", "thinking", "speaking", "praise"];

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
 * the gap between mount and its data actually arriving.
 */
function preloadAvatarVideo(state: AvatarVideoState, timeoutMs = 6000): Promise<void> {
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
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener("loadedmetadata", finish);
      video.removeEventListener("error", finish);
      resolve();
    };
    video.addEventListener("loadedmetadata", finish);
    video.addEventListener("error", finish);
    video.src = `/avatar/${state}.mp4`;
    window.setTimeout(finish, timeoutMs);
  });
}

/** Preloads all 5 avatar clips in parallel — see preloadAvatarVideo.
 * Resolves once every one has settled (loaded, errored, or timed out). */
export function preloadAllAvatarVideos(timeoutMs = 6000): Promise<void> {
  return Promise.all(AVATAR_VIDEO_STATES.map((state) => preloadAvatarVideo(state, timeoutMs))).then(() => undefined);
}
