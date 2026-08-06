"use client";

import { useEffect, useRef, useState } from "react";
import type { AvatarEngine } from "@/core/avatar-engine/AvatarEngine";
import { ALL_SPRITE_KEYS, frameFor, type SpriteKey } from "@/core/avatar-engine/spriteMap";

const FRAMES = ALL_SPRITE_KEYS.map(frameFor);

/**
 * All 9 sprites mount once, here, and never unmount — only their opacity
 * changes. Mounting/unmounting <img> on every state change is what caused
 * the visible flash/decode-delay on each pose's first appearance; with all
 * 9 always in the DOM, the browser has already decoded every frame by the
 * time it's asked to become visible.
 */
export function Avatar({ engine }: { engine: AvatarEngine }) {
  const [activeKey, setActiveKey] = useState<SpriteKey>(engine.getCurrentKey());
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubscribe = engine.subscribe((key, transition) => {
      const el = frameRef.current;
      if (el) {
        el.style.setProperty("--crossfade-ms", `${transition.durationMs}ms`);
        el.style.setProperty("--crossfade-ease", transition.easing);
      }
      setActiveKey(key);
    });
    return unsubscribe;
  }, [engine]);

  return (
    <div className="avatar-frame" ref={frameRef}>
      {FRAMES.map((frame) => (
        <img
          key={frame.key}
          src={frame.src}
          alt=""
          draggable={false}
          className="avatar-sprite-layer"
          style={{ opacity: frame.key === activeKey ? 1 : 0 }}
        />
      ))}
    </div>
  );
}
