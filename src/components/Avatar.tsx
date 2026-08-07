"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AvatarEngine, AvatarVideoState } from "@/core/avatar-engine/AvatarEngine";
import { isIOS } from "@/core/utils/platform";
import { debugLog, describeError } from "@/core/debug/debugStore";

/** Shared by every `<video>.play().catch(...)` in this file — a rejected
 * play() (e.g. NotAllowedError, still possible on iOS if the page-level
 * media unlock — see warmUpAudioContext's unlockAudioForIOS — hasn't run
 * yet) used to be silently swallowed, which is exactly the kind of thing
 * that reads as "frozen" with zero clue why. Now it's at least visible on
 * the ?debug=1 panel. */
function logPlayFailure(clip: string, err: unknown): void {
  debugLog(`${clip}.play() falhou: ${describeError(err)}`);
}

/** Which clip backs each video state — see public/avatar/. Loop policy is
 * handled per-state below, not declared here: idle/listening/thinking
 * genuinely loop forever (native `loop` attribute); speaking and praise
 * are both manually driven (see the effects below) because each needs to
 * stop at a specific, non-arbitrary moment — speaking synced to real TTS
 * audio duration, praise as a fixed one-shot reaction. */
const VIDEO_CLIPS: { state: AvatarVideoState; src: string; loopsForever: boolean }[] = [
  { state: "idle", src: "/avatar/idle.mp4", loopsForever: true },
  { state: "listening", src: "/avatar/listening.mp4", loopsForever: true },
  { state: "thinking", src: "/avatar/thinking.mp4", loopsForever: true },
  { state: "speaking", src: "/avatar/speaking.mp4", loopsForever: false },
  { state: "praise", src: "/avatar/praise.mp4", loopsForever: false },
];

/** How close to the clip's own end (seconds remaining) the loop-seam mask
 * kicks in — see startSpeakingFade's doc comment. Matched to the "últimos
 * 300ms" spec. */
const SPEAKING_FADE_WINDOW_SEC = 0.3;
/** How dark the dip goes — subtle enough to read as a natural breath/blink
 * rather than a visible flicker, but enough to mask the last-frame/first-
 * frame mismatch a talking-mouth clip (not authored as a seamless loop)
 * has at its restart point. */
const SPEAKING_FADE_OPACITY = 0.85;

/**
 * Five <video> elements stacked in the same frame, all mounted from the
 * start and crossfading via opacity (see .avatar-sprite-layer's
 * transition) — only the active AvatarVideoState (see AvatarEngine) is at
 * opacity 1. The 3 always-loop clips (idle/listening/thinking) play
 * continuously in the background even while invisible: calling play() at
 * the moment of a state switch is what causes a visible stutter, so
 * autoplay+loop on all 3 from mount is what makes switching between them
 * instant, just a crossfade with nothing to wait on.
 *
 * praise is different — it's a one-shot reaction, not an ambient loop.
 * See the praise effect below: entering "praise" resets it to frame 0 and
 * plays it once; leaving pauses it (wherever it got to) so a later praise
 * always restarts clean instead of resuming mid-clip or replaying a
 * frozen last frame. CharacterStateMachine's transient timer (~2s — see
 * page.tsx's CharacterStateMachine construction) is what actually reverts
 * the character state afterward; this component only reacts to it.
 *
 * speaking is the third special case — smart-looped to track the ACTUAL
 * duration of whatever TTS audio is currently playing (see the speaking
 * effects below), so a short reply doesn't loop the clip needlessly and a
 * long one doesn't cut off mid-loop or freeze on native infinite loop.
 * Runs with `loop` off and its own manual replay-on-`ended` counter,
 * driven by AvatarEngine.onSpeechAudioDuration/onSpeechSegmentEnded (fed
 * by the orchestrator's real speech "start"/"end"/"error" events — see
 * orchestrator.ts's constructor). While NOT the active state, it still
 * free-runs (replay forever) in the background for the same
 * crossfade-readiness reason the always-loop clips do; only once it
 * becomes the active "speaking" video does a real duration arrive and
 * cap how many times it's allowed to replay for that segment.
 *
 * Because the speaking clip is a talking-mouth animation, not something
 * authored to loop seamlessly, restarting it at frame 0 is visibly
 * abrupt when the last and first frames don't line up (a genuine
 * ping-pong reverse-playback loop was considered and rejected — libx264's
 * B-frames make smooth reverse seeking decode-expensive per step, a real
 * stutter risk on exactly the lower-end Android/4G hardware this app
 * targets, and not something verifiable from this environment). Instead,
 * every restart is masked by a brief opacity dip (see startSpeakingFade/
 * clearSpeakingFade) — a quick, subtle darkening right before the cut and
 * a recovery right after, similar to a blink, cheap enough to never risk
 * jank. This clip's opacity is therefore driven ENTIRELY imperatively
 * (see updateSpeakingOpacity), never through the React `style` prop the
 * other 4 clips use for their crossfade — the reveal-word-by-word text
 * sync re-renders this component very frequently while speaking is
 * active, and a React-driven opacity would reset mid-fade on every one of
 * those re-renders instead of completing smoothly.
 *
 * All 5 videos are muted — both because none of them are supposed to be
 * heard (their own audio tracks are stripped at the source anyway, see
 * public/avatar/ — muted is belt-and-suspenders) and because autoplay
 * without a user gesture is only allowed at all for muted video.
 *
 * If a specific clip fails to load (network hiccup, bad file), that
 * state's video is treated as permanently broken for this session and
 * idle is shown instead whenever that state would otherwise be active —
 * never a blank/broken video.
 */
export function Avatar({ engine }: { engine: AvatarEngine }) {
  // Computed once per mount, not per clip: iOS Safari won't buffer past
  // the response headers without a user gesture regardless of this hint,
  // so asking for "auto" there just wastes bandwidth guessing — see
  // preloadAvatarAssets.ts for the same reasoning.
  const [videoPreload] = useState<"auto" | "metadata">(() => (isIOS() ? "metadata" : "auto"));
  const [videoState, setVideoState] = useState<AvatarVideoState>(engine.getVideoState());
  const [failedStates, setFailedStates] = useState<ReadonlySet<AvatarVideoState>>(new Set());
  const praiseVideoRef = useRef<HTMLVideoElement>(null);
  const speakingVideoRef = useRef<HTMLVideoElement>(null);
  // Infinity = free-running in the background (not the active "speaking"
  // video yet, or no audio-duration signal has arrived for this segment
  // yet) — every real TTS segment start (see the effect below) replaces
  // this with a finite count sized to that segment's actual duration.
  const speakingLoopsRemainingRef = useRef(Infinity);
  // Base visibility (0 or 1, mirrors "is speaking the active state") the
  // fade dip multiplies against — see updateSpeakingOpacity's doc comment
  // for why this can't just be an absolute 0.85/1 value.
  const speakingBaseOpacityRef = useRef(0);
  const speakingFadingRef = useRef(false);

  useEffect(() => engine.subscribe(setVideoState), [engine]);

  // The speaking clip can't use the native `autoPlay` attribute (see
  // VIDEO_CLIPS — it needs manual loop control, so `loop`/`autoPlay` are
  // both off), but it still needs to be free-running in the background
  // from the start for the same crossfade-readiness reason the always-
  // loop clips are: kick it off once here, and handleSpeakingEnded's
  // Infinity branch keeps it going until a real TTS segment arrives. Also
  // sets a fixed, short transition for this ONE clip's opacity (see the
  // component doc comment on why it's driven imperatively, never via
  // React's style prop) — overrides .avatar-sprite-layer's shared 280ms
  // crossfade with something snappier so the loop-seam dip actually
  // resolves within its ~300ms window instead of still animating when
  // reversed.
  useEffect(() => {
    const video = speakingVideoRef.current;
    if (!video) return;
    video.style.transition = "opacity 150ms ease";
    void video.play().catch((err) => logPlayFailure("speaking", err));
  }, []);

  // Falls back to "idle" for a state whose clip failed to load — see this
  // component's doc comment. Doesn't fall back FROM idle itself (nothing
  // left to fall back to).
  const effectiveState = videoState !== "idle" && failedStates.has(videoState) ? "idle" : videoState;

  useEffect(() => {
    const video = praiseVideoRef.current;
    if (!video) return;
    if (effectiveState === "praise") {
      video.currentTime = 0;
      void video.play().catch((err) => logPlayFailure("praise", err));
    } else {
      video.pause();
    }
  }, [effectiveState]);

  /** Writes the speaking clip's real, current opacity from its two
   * independent inputs — see the ref doc comments — instead of an
   * absolute value, so the fade dip is invisible (0 * 0.85 = 0) whenever
   * the clip isn't actually the one on screen, and only dips the ACTUALLY
   * visible layer (1 * 0.85 = 0.85) while it's speaking's turn. */
  function updateSpeakingOpacity() {
    const video = speakingVideoRef.current;
    if (!video) return;
    const opacity = speakingBaseOpacityRef.current * (speakingFadingRef.current ? SPEAKING_FADE_OPACITY : 1);
    video.style.opacity = String(opacity);
  }

  // useLayoutEffect, not useEffect: this runs synchronously right after
  // the DOM update but BEFORE the browser paints. Since the speaking
  // clip's opacity has no React `style` prop to give it an initial value
  // (see the render below), an ordinary useEffect here would leave one
  // paint where this element has no opacity set at all — defaulting to
  // fully opaque — flashing its poster image over whatever's actually
  // active. Running synchronously pre-paint closes that gap.
  useLayoutEffect(() => {
    speakingBaseOpacityRef.current = effectiveState === "speaking" ? 1 : 0;
    // A fade left mid-dip by an interruption (e.g. the student clicked
    // away right as the tutor started speaking) must not carry into the
    // next time this clip becomes active.
    speakingFadingRef.current = false;
    updateSpeakingOpacity();
  }, [effectiveState]);

  // Resets the speaking clip's manual loop budget back to "free-running"
  // whenever it stops being the active state — otherwise a leftover
  // finite count from the last turn would cap its NEXT background
  // free-run too, instead of only the segment it was actually measured for.
  useEffect(() => {
    if (effectiveState !== "speaking") speakingLoopsRemainingRef.current = Infinity;
  }, [effectiveState]);

  // Loop-seam mask (see the component doc comment's "ping-pong rejected"
  // paragraph): watches the speaking clip's own playback position — not
  // gated on effectiveState, since the fade must arm even while this clip
  // is only free-running in the background, so it's already primed by the
  // time it might actually need to become visible. Dips right before each
  // restart, restored right after (see the two restart call sites below).
  useEffect(() => {
    const video = speakingVideoRef.current;
    if (!video) return;
    const onTimeUpdate = () => {
      if (speakingFadingRef.current) return;
      if (!Number.isFinite(video.duration)) return;
      if (video.duration - video.currentTime <= SPEAKING_FADE_WINDOW_SEC) {
        speakingFadingRef.current = true;
        updateSpeakingOpacity();
      }
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, []);

  /** Clears the fade dip and restarts playback from frame 0 — the one
   * sequence every loop restart goes through, called from both
   * onSpeechAudioDuration's fresh-segment reset and
   * handleSpeakingEnded's mid-segment loop continuation below. */
  function restartSpeakingClip(video: HTMLVideoElement) {
    speakingFadingRef.current = false;
    updateSpeakingOpacity();
    video.currentTime = 0;
    void video.play().catch((err) => logPlayFailure("speaking", err));
  }

  useEffect(() => {
    // Fires once per individual TTS audio segment's real start (see
    // AvatarEngine.setSpeechAudioDuration's doc comment) — sizes the
    // speaking clip's loop budget to THIS segment's actual duration and
    // restarts it cleanly from frame 0, so a fresh segment never inherits
    // a stale mid-loop position from whatever played right before it.
    return engine.onSpeechAudioDuration((durationSec) => {
      const video = speakingVideoRef.current;
      if (!video) return;
      const clipSeconds = video.duration;
      speakingLoopsRemainingRef.current =
        durationSec && durationSec > 0 && Number.isFinite(clipSeconds) && clipSeconds > 0
          ? Math.max(1, Math.ceil(durationSec / clipSeconds))
          : 1;
      restartSpeakingClip(video);
    });
  }, [engine]);

  useEffect(() => {
    // Fires once per individual TTS audio segment's real end/error (see
    // AvatarEngine.notifySpeechSegmentEnded's doc comment) — if the clip
    // still has most of a loop left to run (a short trailing segment,
    // e.g. "Africa." lasting a fraction of the clip's own length), don't
    // let the video keep "talking" into silence: snap to a neutral frame
    // right away instead of riding out the rest of that loop.
    return engine.onSpeechSegmentEnded(() => {
      const video = speakingVideoRef.current;
      if (!video) return;
      if (speakingLoopsRemainingRef.current <= 1) {
        video.pause();
        video.currentTime = 0;
        speakingFadingRef.current = false;
        updateSpeakingOpacity();
      }
      speakingLoopsRemainingRef.current = 0;
    });
  }, [engine]);

  function handleSpeakingEnded() {
    const video = speakingVideoRef.current;
    if (!video) return;
    if (speakingLoopsRemainingRef.current === Infinity) {
      restartSpeakingClip(video);
      return;
    }
    speakingLoopsRemainingRef.current -= 1;
    if (speakingLoopsRemainingRef.current > 0) {
      restartSpeakingClip(video);
    }
    // Otherwise: budget exhausted — let it sit on this final frame (a
    // real TTS segment's real "end" arriving is what normally cuts this
    // short anyway, via onSpeechSegmentEnded above; this is the fallback
    // for when the clip's own last loop simply finishes first).
  }

  return (
    <div className="avatar-frame">
      {VIDEO_CLIPS.map(({ state, src, loopsForever }) => (
        <video
          key={state}
          ref={state === "praise" ? praiseVideoRef : state === "speaking" ? speakingVideoRef : undefined}
          src={src}
          poster="/avatar/poster.jpg"
          loop={loopsForever}
          autoPlay={loopsForever} // speaking/praise are started/reset imperatively, not on mount
          muted
          playsInline
          preload={videoPreload}
          className="avatar-sprite-layer"
          // The speaking clip's opacity is set imperatively (see this
          // component's doc comment) — omitting the style prop for it
          // here is what keeps React from stomping on that mid-fade.
          style={state === "speaking" ? undefined : { opacity: effectiveState === state ? 1 : 0 }}
          onError={() => setFailedStates((prev) => new Set(prev).add(state))}
          onEnded={state === "speaking" ? handleSpeakingEnded : undefined}
        />
      ))}
    </div>
  );
}
