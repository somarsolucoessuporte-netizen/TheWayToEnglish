/**
 * Preloads the avatar's two assets — idle.png (decoded via Image()) and
 * speaking.mp4 (buffered up to "canplaythrough", i.e. enough that it can
 * play through without stalling for more data) — used by the app's boot
 * loading gate (see app/page.tsx) so neither the resting frame nor the
 * speaking video is still loading when the avatar first mounts. Replaces
 * the old 9-sprite preload (see public/avatar/_old_sprites/) now that
 * there are only two assets instead of nine. Resolves once both are
 * ready, or after `timeoutMs` for the video (a slow connection shouldn't
 * hang the loading screen forever) — never rejects.
 */
export function preloadAvatarAssets(timeoutMs = 5000): Promise<void> {
  const imageLoad = new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = "/avatar/idle.png";
  });

  const videoLoad = new Promise<void>((resolve) => {
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
    video.src = "/avatar/speaking.mp4";
    window.setTimeout(finish, timeoutMs);
  });

  return Promise.all([imageLoad, videoLoad]).then(() => undefined);
}
