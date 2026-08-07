"use client";

import { useEffect, useRef, useState } from "react";
import type { AvatarEngine, AvatarVideoState } from "@/core/avatar-engine/AvatarEngine";

/** Which clip backs each video state, and whether it loops — see
 * public/avatar/. Only "praise" doesn't loop (see the play/pause effect
 * below): it's a one-shot reaction, not an ambient idle-style clip. */
const VIDEO_CLIPS: { state: AvatarVideoState; src: string; loop: boolean }[] = [
  { state: "idle", src: "/avatar/idle.mp4", loop: true },
  { state: "listening", src: "/avatar/listening.mp4", loop: true },
  { state: "thinking", src: "/avatar/thinking.mp4", loop: true },
  { state: "speaking", src: "/avatar/speaking.mp4", loop: true },
  { state: "praise", src: "/avatar/praise.mp4", loop: false },
];

/**
 * Five <video> elements stacked in the same frame, all mounted from the
 * start and crossfading via opacity (see .avatar-sprite-layer's
 * transition) — only the active AvatarVideoState (see AvatarEngine) is at
 * opacity 1. The 4 loopable clips (idle/listening/thinking/speaking) play
 * continuously in the background even while invisible: calling play() at
 * the moment of a state switch is what causes a visible stutter, so
 * autoplay+loop on all 4 from mount is what makes switching between them
 * instant, just a crossfade with nothing to wait on.
 *
 * praise is different — it's a one-shot reaction, not an ambient loop.
 * See the effect below: entering "praise" resets it to frame 0 and plays
 * it once; leaving pauses it (wherever it got to) so a later praise
 * always restarts clean instead of resuming mid-clip or replaying a
 * frozen last frame. CharacterStateMachine's transient timer (~2s — see
 * page.tsx's CharacterStateMachine construction) is what actually reverts
 * the character state afterward; this component only reacts to it.
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

  useEffect(() => engine.subscribe(setVideoState), [engine]);

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

  return (
    <div className="avatar-frame">
      {VIDEO_CLIPS.map(({ state, src, loop }) => (
        <video
          key={state}
          ref={state === "praise" ? praiseVideoRef : undefined}
          src={src}
          poster="/avatar/poster.jpg"
          loop={loop}
          autoPlay={loop} // praise is started/reset imperatively, not on mount
          muted
          playsInline
          preload="auto"
          className="avatar-sprite-layer"
          style={{ opacity: effectiveState === state ? 1 : 0 }}
          onError={() => setFailedStates((prev) => new Set(prev).add(state))}
        />
      ))}
    </div>
  );
}
