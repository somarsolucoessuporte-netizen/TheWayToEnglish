import type { AvatarVideoState } from "./AvatarEngine";

/** Every clip the avatar can show — see public/avatar/ and Avatar.tsx's
 * VIDEO_CLIPS. Preloaded together during the boot loading screen (see
 * page.tsx's runBoot) so switching between them is always an instant
 * crossfade, never a network wait mid-conversation. */
const AVATAR_VIDEO_STATES: AvatarVideoState[] = ["idle", "listening", "thinking", "speaking", "praise"];

/**
 * Buffers one avatar clip up to "canplaythrough" (enough that it can play
 * through without stalling for more data). Resolves once ready, or after
 * `timeoutMs` (a slow connection shouldn't hang the loading screen
 * forever) — never rejects, even on a genuine load error: Avatar.tsx's
 * own per-video onError handler is what falls back to idle for a clip
 * that's actually broken, not the boot gate refusing to release the app.
 */
function preloadAvatarVideo(state: AvatarVideoState, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener("canplaythrough", finish);
      video.removeEventListener("error", finish);
      resolve();
    };
    video.addEventListener("canplaythrough", finish);
    video.addEventListener("error", finish);
    video.src = `/avatar/${state}.mp4`;
    window.setTimeout(finish, timeoutMs);
  });
}

/** Preloads all 5 avatar clips in parallel — see preloadAvatarVideo.
 * Resolves once every one has settled (loaded, errored, or timed out). */
export function preloadAllAvatarVideos(timeoutMs = 5000): Promise<void> {
  return Promise.all(AVATAR_VIDEO_STATES.map((state) => preloadAvatarVideo(state, timeoutMs))).then(() => undefined);
}
