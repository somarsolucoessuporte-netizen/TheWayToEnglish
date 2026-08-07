/**
 * iOS Safari (including iPadOS, which reports itself as "MacIntel" — the
 * same platform string a real Mac uses — but exposes touch points a Mac
 * never does) needs several code paths nothing else does: it never fires
 * "canplaythrough" on a <video> without a prior user gesture, and both
 * video-with-sound and Web Audio playback require that gesture to
 * originate synchronously inside a click handler. See preloadAvatarAssets.ts
 * and warmUpAudioContext.ts's unlockAudioForIOS.
 */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
