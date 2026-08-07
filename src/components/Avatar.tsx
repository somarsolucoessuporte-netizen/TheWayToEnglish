"use client";

import { useEffect, useRef, useState } from "react";
import type { AvatarEngine } from "@/core/avatar-engine/AvatarEngine";
import type { CharacterState } from "@/core/character-state-machine/stateMachine";

/**
 * Two elements stacked in the same frame, crossfading via opacity:
 * idle.png (a real frame extracted from speaking.mp4 itself — see
 * public/avatar/_old_sprites/ for the retired 9-sprite PNG system this
 * replaced) for every non-speaking state, and the looping speaking video
 * while "speaking". Because idle.png comes from the video itself, the
 * 150ms crossfade (see .avatar-sprite-layer) has no lighting/framing/scale
 * mismatch to hide — unlike the old sprite set, which was assembled from
 * different rows of a source grid with visible micro-differences between
 * frames.
 *
 * Play/pause is driven ONLY by the "speaking" CharacterState, which is
 * itself driven only by real SpeechProvider "start"/"end" audio events —
 * never a timer or an estimated duration (see orchestrator's
 * speech.on("start", ...) handler and speakParts). That state already
 * spans an entire multi-part turn (a bilingual reply's English+Portuguese
 * parts, or a correction's full "hear it, repeat it" pronunciation drill)
 * as ONE continuous "speaking" stretch — speakParts dispatches SPEECH_END
 * only once, after every part is done — so the video is never restarted
 * mid-turn, only at the true start and true end of one.
 */
export function Avatar({ engine }: { engine: AvatarEngine }) {
  const [state, setState] = useState<CharacterState>(engine.getCurrentState());
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => engine.subscribe(setState), [engine]);

  const isSpeaking = state === "speaking";

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isSpeaking) {
      video.currentTime = 0;
      void video.play().catch(() => {});
    } else {
      video.pause();
      video.currentTime = 0;
    }
  }, [isSpeaking]);

  return (
    <div className="avatar-frame">
      <img
        src="/avatar/idle.png"
        alt=""
        draggable={false}
        className="avatar-sprite-layer"
        style={{ opacity: isSpeaking ? 0 : 1 }}
      />
      <video
        ref={videoRef}
        src="/avatar/speaking.mp4"
        loop
        muted
        playsInline
        preload="auto"
        className="avatar-sprite-layer"
        style={{ opacity: isSpeaking ? 1 : 0 }}
      />
    </div>
  );
}
