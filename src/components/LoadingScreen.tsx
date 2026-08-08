"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { preload } from "react-dom";
import { branding } from "@/app-config/branding";

/**
 * Full-screen boot gate shown while the avatar assets, TTS warm-up,
 * AudioContext and /api/chat health check are still settling (see the
 * boot sequence in app/page.tsx) — the avatar and chat never mount before
 * ALL of that finishes, so they can't try to start against half-loaded
 * assets or a cold API. "timeout" is a distinct status from "error": it
 * means boot was still in progress past the 8s safety net, not that any
 * individual step definitively failed.
 *
 * Visually this plays a 4-scene opening (white logo card → 2 photo scenes
 * with copy → tutor-teaser photo with the loader) before settling on scene
 * 4, which is the state that actually reflects `status`/`statusText`. The
 * opening is purely decorative and timer-driven — it never gates or delays
 * the real boot work happening in parallel in app/page.tsx.
 */

type LogoScene = {
  id: 1;
  kind: "logo";
  duration: number;
  transitionMs: number;
};

type PhotoScene = {
  id: 2 | 3 | 4;
  kind: "photo";
  desktop: string;
  mobile: string;
  origin: string;
  /** ms this scene owns before the next one takes over; null = holds indefinitely (scene 4). */
  duration: number | null;
  transitionMs: number;
};

type Scene = LogoScene | PhotoScene;

const SCENES: Scene[] = [
  { id: 1, kind: "logo", duration: 1800, transitionMs: 500 },
  {
    id: 2,
    kind: "photo",
    desktop: "/splash/entrada_destop2.jpg",
    mobile: "/splash/entrada_mobile2.jpg",
    origin: "center center",
    duration: 3000,
    transitionMs: 500,
  },
  {
    id: 3,
    kind: "photo",
    desktop: "/splash/entrada_destop.jpg",
    mobile: "/splash/entrada_mobile1.jpg",
    origin: "top left",
    // 2700, not the full 3000 asked for — keeps this scene's own Ken Burns
    // pacing consistent with the moment it's actually swapped out, so scene
    // 4 lands on the requested 7.5s total (1800 + 3000 + 2700) instead of
    // 7800.
    duration: 2700,
    transitionMs: 400,
  },
  {
    id: 4,
    kind: "photo",
    desktop: "/splash/entrada_destop1.jpg",
    mobile: "/splash/entrada_mobile.jpg",
    origin: "bottom right",
    duration: null,
    transitionMs: 400,
  },
];

// Cumulative start offset (ms from mount) for each scene, matching SCENES order.
const SCENE_STARTS = [0, 1800, 4800, 7500];
const SKIP_VISIBLE_AT_MS = 2000;

const LOGO_SRC = "/logo.png";
// Only the first photo scene (both breakpoints) + the logo get a resource
// hint — the other photos load naturally as their scene comes up. Preloading
// all of them would compete for bandwidth with the avatar video/TTS/chat
// boot work this screen is covering for, which must not slow down.
const firstPhotoScene = SCENES[1] as PhotoScene;
const PRELOAD_SRCS = [LOGO_SRC, firstPhotoScene.desktop, firstPhotoScene.mobile];

export function LoadingScreen({
  status,
  fadingOut,
  progressPct = 0,
  statusText,
}: {
  status: "loading" | "error" | "timeout";
  fadingOut: boolean;
  progressPct?: number;
  statusText?: string;
}) {
  // Resource hints for scene 2's photo + the logo only (see PRELOAD_SRCS) —
  // emitted during render (React 19's documented pattern for preload()).
  for (const src of PRELOAD_SRCS) {
    preload(src, { as: "image" });
  }

  const [sceneIndex, setSceneIndex] = useState<1 | 2 | 3 | 4>(1);
  const [skipVisible, setSkipVisible] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useLayoutEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mql.matches);
    const handleChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      setSceneIndex(4);
      return;
    }
    timeoutsRef.current = [
      setTimeout(() => setSceneIndex(2), SCENE_STARTS[1]),
      setTimeout(() => setSceneIndex(3), SCENE_STARTS[2]),
      setTimeout(() => setSceneIndex(4), SCENE_STARTS[3]),
      setTimeout(() => setSkipVisible(true), SKIP_VISIBLE_AT_MS),
    ];
    return () => {
      for (const t of timeoutsRef.current) clearTimeout(t);
    };
  }, [reducedMotion]);

  // page.tsx unmounts this component a fixed delay after fadingOut flips
  // true — that timing lives outside this file, so it can't be stretched
  // from here. What this file *can* guarantee: whatever frame is on screen
  // for that last stretch is the branded loader (scene 4), never a photo
  // caught mid Ken Burns zoom or the white logo card mid-pulse.
  useEffect(() => {
    if (!fadingOut) return;
    for (const t of timeoutsRef.current) clearTimeout(t);
    setSceneIndex(4);
    setSkipVisible(false);
  }, [fadingOut]);

  const handleSkip = () => {
    for (const t of timeoutsRef.current) clearTimeout(t);
    setSceneIndex(4);
    setSkipVisible(false);
  };

  // Once boot definitively fails/times out, stop cycling scenes and settle
  // on scene 4's frame so the retry UI has a steady backdrop.
  const effectiveScene = status === "loading" ? sceneIndex : 4;

  return (
    <div
      className={`wtes-root${fadingOut ? " wtes-fadeout" : ""}${reducedMotion ? " wtes-reduced" : ""}`}
    >
      <style>{`
        .wtes-root {
          position: fixed;
          inset: 0;
          width: 100vw;
          height: 100dvh;
          z-index: 50;
          overflow: hidden;
          background: #0a0a0a;
          opacity: 1;
          transition: opacity 400ms ease;
        }
        .wtes-fadeout {
          opacity: 0;
          pointer-events: none;
        }
        .wtes-scene {
          position: absolute;
          inset: 0;
          width: 100vw;
          height: 100dvh;
          opacity: 0;
          transition-property: opacity;
          transition-timing-function: ease;
        }
        .wtes-scene-active {
          opacity: 1;
        }
        .wtes-reduced .wtes-scene {
          transition: none;
        }
        .wtes-scene-white {
          background: #ffffff;
        }
        .wtes-kenburns {
          position: absolute;
          inset: 0;
          overflow: hidden;
        }
        .wtes-kenburns-anim {
          animation-name: wtes-kenburns;
          animation-timing-function: ease-out;
          animation-fill-mode: forwards;
        }
        .wtes-reduced .wtes-kenburns-anim {
          animation: none;
        }
        @keyframes wtes-kenburns {
          from { transform: scale(1); }
          to { transform: scale(1.07); }
        }
        .wtes-bg {
          position: absolute;
          inset: 0;
          background-size: cover;
          background-position: center;
        }
        .wtes-bg-mobile {
          display: none;
        }
        @media (max-width: 767px) {
          .wtes-bg-desktop { display: none; }
          .wtes-bg-mobile { display: block; }
        }
        .wtes-overlay {
          position: absolute;
          inset: 0;
          background: linear-gradient(
            to bottom,
            rgba(28, 43, 108, 0.55) 0%,
            rgba(28, 43, 108, 0.25) 50%,
            rgba(28, 43, 108, 0.7) 100%
          );
        }
        .wtes-content {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          padding: 24px;
          text-align: center;
          color: #fff;
        }
        .wtes-title,
        .wtes-subtitle,
        .wtes-caption {
          text-shadow: 0 1px 12px rgba(0, 0, 0, 0.3);
        }
        .wtes-logo-big {
          width: min(220px, 70vw);
          height: auto;
          animation: wtes-logo-entrance 700ms cubic-bezier(0.16, 1, 0.3, 1) 0ms forwards,
            wtes-logo-pulse 800ms ease-in-out 700ms forwards,
            wtes-logo-exit 300ms ease 1500ms forwards;
        }
        .wtes-reduced .wtes-logo-big {
          animation: none;
        }
        @keyframes wtes-logo-entrance {
          0% { opacity: 0; transform: scale(0.88); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes wtes-logo-pulse {
          0% { transform: scale(1); }
          25% { transform: scale(1.08); }
          50% { transform: scale(1); }
          75% { transform: scale(1.06); }
          100% { transform: scale(1); }
        }
        @keyframes wtes-logo-exit {
          0% { opacity: 1; transform: scale(1); }
          100% { opacity: 0; transform: scale(0.95); }
        }
        .wtes-title {
          font-size: 38px;
          font-weight: 700;
          color: #fff;
          max-width: 20ch;
        }
        .wtes-subtitle {
          font-size: 22px;
          font-weight: 400;
          color: rgba(255, 255, 255, 0.85);
          max-width: 26ch;
        }
        .wtes-wordmark {
          font-size: 16px;
          font-weight: 600;
          color: #fff;
          opacity: 0.9;
          text-align: center;
          margin-bottom: 32px;
          letter-spacing: 0.5px;
        }
        .wtes-caption {
          font-size: 18px;
          font-weight: 400;
          color: rgba(255, 255, 255, 0.7);
        }
        .wtes-error-text {
          max-width: 320px;
          font-size: 14px;
          color: rgba(255, 255, 255, 0.85);
        }
        .wtes-skip {
          position: absolute;
          right: 20px;
          bottom: 20px;
          z-index: 2;
          border: none;
          background: transparent;
          color: rgba(255, 255, 255, 0.6);
          font-size: 13px;
          cursor: pointer;
          padding: 8px;
          opacity: 0;
          transition: opacity 300ms ease;
        }
        .wtes-skip-on-white {
          color: #555555;
        }
        .wtes-skip-visible {
          opacity: 1;
        }
        .wtes-three-body {
          --uib-size: 72px;
          --uib-speed: 0.8s;
          --uib-color: #1c2b6c;
          position: relative;
          display: inline-block;
          height: var(--uib-size);
          width: var(--uib-size);
          margin: 0 auto 20px;
          animation: wtes-spin78236 calc(var(--uib-speed) * 2.5) infinite linear;
        }
        .wtes-three-body__dot {
          position: absolute;
          height: 100%;
          width: 30%;
          top: 0;
          left: 0;
        }
        .wtes-three-body__dot:after {
          content: "";
          position: absolute;
          height: 0%;
          width: 100%;
          padding-bottom: 100%;
          background-color: var(--uib-color);
          border-radius: 50%;
        }
        .wtes-three-body__dot:nth-child(1) {
          bottom: 5%;
          left: 0;
          transform: rotate(60deg);
          transform-origin: 50% 85%;
        }
        .wtes-three-body__dot:nth-child(1)::after {
          bottom: 0;
          left: 0;
          animation: wtes-wobble1 var(--uib-speed) infinite ease-in-out;
          animation-delay: calc(var(--uib-speed) * -0.3);
        }
        .wtes-three-body__dot:nth-child(2) {
          bottom: 5%;
          right: 0;
          transform: rotate(-60deg);
          transform-origin: 50% 85%;
        }
        .wtes-three-body__dot:nth-child(2)::after {
          bottom: 0;
          right: 0;
          animation: wtes-wobble1 var(--uib-speed) infinite calc(var(--uib-speed) * -0.15) ease-in-out;
        }
        .wtes-three-body__dot:nth-child(3) {
          bottom: -5%;
          left: 0;
          transform: translateX(116.666%);
        }
        .wtes-three-body__dot:nth-child(3)::after {
          top: 0;
          left: 0;
          animation: wtes-wobble2 var(--uib-speed) infinite ease-in-out;
        }
        @keyframes wtes-spin78236 {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes wtes-wobble1 {
          0%, 100% { transform: translateY(0%) scale(1); opacity: 1; }
          50% { transform: translateY(-66%) scale(0.65); opacity: 0.8; }
        }
        @keyframes wtes-wobble2 {
          0%, 100% { transform: translateY(0%) scale(1); opacity: 1; }
          50% { transform: translateY(66%) scale(0.65); opacity: 0.8; }
        }
        .wtes-reduced .wtes-three-body,
        .wtes-reduced .wtes-three-body__dot::after {
          animation: none;
        }
        @media (prefers-reduced-motion: reduce) {
          .wtes-scene { transition: none; }
          .wtes-kenburns-anim { animation: none; }
          .wtes-logo-big { animation: none; }
          .wtes-three-body,
          .wtes-three-body__dot::after { animation: none; }
        }
      `}</style>

      {SCENES.map((scene) => (
        <div
          key={scene.id}
          className={`wtes-scene${effectiveScene === scene.id ? " wtes-scene-active" : ""}${scene.kind === "logo" ? " wtes-scene-white" : ""}`}
          style={{ transitionDuration: `${scene.transitionMs}ms` }}
        >
          {scene.kind === "photo" && (
            <>
              <div
                className={`wtes-kenburns${scene.duration && !reducedMotion ? " wtes-kenburns-anim" : ""}`}
                style={{
                  transformOrigin: scene.origin,
                  animationDelay: scene.duration ? `${SCENE_STARTS[scene.id - 1]}ms` : undefined,
                  animationDuration: scene.duration ? `${scene.duration}ms` : undefined,
                }}
              >
                <div className="wtes-bg wtes-bg-desktop" style={{ backgroundImage: `url(${scene.desktop})` }} />
                <div className="wtes-bg wtes-bg-mobile" style={{ backgroundImage: `url(${scene.mobile})` }} />
              </div>
              <div className="wtes-overlay" />
            </>
          )}

          <div className="wtes-content">
            {scene.id === 1 && <img className="wtes-logo-big" src={LOGO_SRC} alt={branding.companyName} />}

            {scene.id === 2 && <div className="wtes-title">Aprenda inglês em qualquer lugar.</div>}

            {scene.id === 3 && (
              <>
                <div className="wtes-title">A qualquer hora, no seu ritmo.</div>
                <div className="wtes-subtitle">Com uma professora sempre disponível.</div>
              </>
            )}

            {scene.id === 4 && (
              <>
                <div className="wtes-wordmark">{branding.companyName}</div>
                {status === "loading" ? (
                  <>
                    <div className="wtes-three-body" role="progressbar" aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}>
                      <div className="wtes-three-body__dot" />
                      <div className="wtes-three-body__dot" />
                      <div className="wtes-three-body__dot" />
                    </div>
                    <div className="wtes-caption" aria-live="polite">
                      {statusText || "Preparando sua aula..."}
                    </div>
                  </>
                ) : (
                  <>
                    <p className="wtes-error-text">
                      {status === "timeout" ? branding.copy.bootTimeoutText : branding.copy.bootErrorText}
                    </p>
                    {/* A full reload, not a re-run of the in-memory boot promise —
                        if the app got this far into a broken/slow state, starting
                        the JS runtime over is the more reliable recovery than
                        trusting its own retry logic. */}
                    <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                      {branding.copy.bootRetryButton}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      ))}

      {status === "loading" && effectiveScene !== 4 && !reducedMotion && (
        <button
          type="button"
          className={`wtes-skip${effectiveScene === 1 ? " wtes-skip-on-white" : ""}${skipVisible ? " wtes-skip-visible" : ""}`}
          onClick={handleSkip}
        >
          Pular ▸
        </button>
      )}
    </div>
  );
}
