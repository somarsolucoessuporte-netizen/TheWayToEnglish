/**
 * Decodes idle.png via Image().onload — used by the app's boot loading gate
 * (see app/page.tsx) so the resting frame isn't still loading when the
 * avatar first mounts. Never rejects: a failed load still resolves (the
 * <img> in Avatar.tsx will just show a broken image, which is a smaller
 * problem than hanging the boot gate forever over one asset).
 */
export function preloadAvatarImage(): Promise<void> {
  return new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = "/avatar/idle.png";
  });
}

/**
 * Buffers speaking.mp4 up to "canplaythrough" (enough that it can play
 * through without stalling for more data) — used alongside
 * preloadAvatarImage by the boot gate. Resolves once ready, or after
 * `timeoutMs` (a slow connection shouldn't hang the loading screen
 * forever) — never rejects.
 */
export function preloadAvatarVideo(timeoutMs = 5000): Promise<void> {
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
    video.src = "/avatar/speaking.mp4";
    window.setTimeout(finish, timeoutMs);
  });
}
