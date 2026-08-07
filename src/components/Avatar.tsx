"use client";

import { useEffect, useRef, useState } from "react";
import type { AvatarEngine, AvatarVideoState } from "@/core/avatar-engine/AvatarEngine";

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
  const [videoState, setVideoState] = useState<AvatarVideoState>(engine.getVideoState());
  const [failedStates, setFailedStates] = useState<ReadonlySet<AvatarVideoState>>(new Set());
  const praiseVideoRef = useRef<HTMLVideoElement>(null);
  const speakingVideoRef = useRef<HTMLVideoElement>(null);
  // Infinity = free-running in the background (not the active "speaking"
  // video yet, or no audio-duration signal has arrived for this segment
  // yet) — every real TTS segment start (see the effect below) replaces
  // this with a finite count sized to that segment's actual duration.
  const speakingLoopsRemainingRef = useRef(Infinity);

  useEffect(() => engine.subscribe(setVideoState), [engine]);

  // The speaking clip can't use the native `autoPlay` attribute (see
  // VIDEO_CLIPS — it needs manual loop control, so `loop`/`autoPlay` are
  // both off), but it still needs to be free-running in the background
  // from the start for the same crossfade-readiness reason the always-
  // loop clips are: kick it off once here, and handleSpeakingEnded's
  // Infinity branch keeps it going until a real TTS segment arrives.
  useEffect(() => {
    void speakingVideoRef.current?.play().catch(() => {});
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
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [effectiveState]);

  // Resets the speaking clip's manual loop budget back to "free-running"
  // whenever it stops being the active state — otherwise a leftover
  // finite count from the last turn would cap its NEXT background
  // free-run too, instead of only the segment it was actually measured for.
  useEffect(() => {
    if (effectiveState !== "speaking") speakingLoopsRemainingRef.current = Infinity;
  }, [effectiveState]);

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
      video.currentTime = 0;
      void video.play().catch(() => {});
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
      }
      speakingLoopsRemainingRef.current = 0;
    });
  }, [engine]);

  function handleSpeakingEnded() {
    const video = speakingVideoRef.current;
    if (!video) return;
    if (speakingLoopsRemainingRef.current === Infinity) {
      video.currentTime = 0;
      void video.play().catch(() => {});
      return;
    }
    speakingLoopsRemainingRef.current -= 1;
    if (speakingLoopsRemainingRef.current > 0) {
      video.currentTime = 0;
      void video.play().catch(() => {});
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
          preload="auto"
          className="avatar-sprite-layer"
          style={{ opacity: effectiveState === state ? 1 : 0 }}
          onError={() => setFailedStates((prev) => new Set(prev).add(state))}
          onEnded={state === "speaking" ? handleSpeakingEnded : undefined}
        />
      ))}
    </div>
  );
}
