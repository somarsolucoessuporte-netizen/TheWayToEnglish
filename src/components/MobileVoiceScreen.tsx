"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { branding } from "@/app-config/branding";
import type { CurriculumLesson } from "@/app-config/curriculum";
import type { DemoStudent } from "@/app-config/demo-students";
import type { AvatarEngine } from "@/core/avatar-engine/AvatarEngine";
import type { CharacterState } from "@/core/character-state-machine/stateMachine";
import type { ChatEntry } from "@/core/conversation/orchestrator";
import { Avatar } from "./Avatar";
import { ChatLog } from "./ChatLog";
import { ForceSendButton } from "./ForceSendButton";
import { LessonCompleteCard } from "./LessonCompleteCard";
import { LessonTimer } from "./LessonTimer";
import { TipsPanel, type TipsAttention } from "./TipsPanel";

/** Below this drag-position percentage (0 = fully open, 100 = fully
 * closed) the drawer snaps open on release; at/above it, closed. Only
 * consulted when the release velocity is too slow to decide on its own
 * (see DRAG_VELOCITY_THRESHOLD). */
const DRAG_POSITION_SNAP_THRESHOLD = 50;
/** px/ms at release — a flick faster than this snaps in the direction of
 * the flick regardless of how far the drawer actually travelled, matching
 * the "velocidade do gesto" requirement (a quick short flick should still
 * complete the gesture, not just the safe halfway-point rule). */
const DRAG_VELOCITY_THRESHOLD = 0.5;

interface DragState {
  startY: number;
  /** Drawer position (0-100, same scale as translateY%) at the moment
   * this drag began — dragging is additive on top of it, not absolute. */
  startPct: number;
  lastY: number;
  lastT: number;
  /** px/ms, signed: negative = moving up (toward open). */
  velocity: number;
  heightPx: number;
}

/**
 * Voice-first mobile layout (<768px — see components/useIsMobile.ts): the
 * avatar fills the entire screen (100dvh, object-fit: cover) with the
 * header, caption and Falar/tips controls floating over it. The full
 * transcript and text input live in a bottom sheet ("gaveta") that slides
 * up over the avatar — dragged open by its handle, or opened
 * automatically when a correction card needs to be seen — instead of
 * being always visible, so the avatar (and the student's ability to watch
 * the tutor while she talks) stays the primary view. Desktop keeps the
 * original side-by-side layout untouched (see page.tsx).
 */
export function MobileVoiceScreen({
  avatarEngine,
  started,
  characterState,
  demoStudents,
  onStudentPick,
  onTalkClick,
  totalSeconds,
  remainingSeconds,
  showTimeUpNotice,
  entries,
  currentLesson,
  currentHint,
  tipsAttention,
  onTipsBlinkEnd,
  inputValue,
  onInputChange,
  onSubmit,
  lessonComplete,
  onEndLesson,
}: {
  avatarEngine: AvatarEngine;
  started: boolean;
  characterState: CharacterState;
  demoStudents: readonly DemoStudent[];
  onStudentPick: (student: DemoStudent) => void;
  onTalkClick: () => void;
  totalSeconds: number;
  remainingSeconds: number;
  showTimeUpNotice: boolean;
  entries: ChatEntry[];
  currentLesson: CurriculumLesson | undefined;
  currentHint: string | undefined;
  tipsAttention: TipsAttention;
  onTipsBlinkEnd: () => void;
  inputValue: string;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (e: React.FormEvent) => void;
  lessonComplete: boolean;
  onEndLesson: () => void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  // Direct DOM writes during drag/snap on purpose — see the module doc
  // comment's "transform, never height" note. Driving a 60fps drag through
  // React state would mean a re-render per pointermove; mutating the
  // transform imperatively and only syncing `drawerOpen` (for conditional
  // rendering, e.g. hiding the floating controls) on release keeps the
  // gesture itself entirely off the render path.
  function setDrawerTransform(pct: number, animated: boolean) {
    const el = drawerRef.current;
    if (!el) return;
    el.style.transition = animated ? "" : "none";
    el.style.transform = `translateY(${pct}%)`;
  }

  function openDrawer() {
    setDrawerOpen(true);
    setDrawerTransform(0, true);
  }

  function closeDrawer() {
    setDrawerOpen(false);
    setDrawerTransform(100, true);
  }

  function handleTalkClick() {
    // "Fecha sozinha quando: o aluno clica em Falar" — the button is only
    // rendered while the drawer is closed (see the floating controls
    // below), so this mainly guards a mid-fade edge case, but costs
    // nothing to call unconditionally.
    closeDrawer();
    onTalkClick();
  }

  function handleHandlePointerDown(e: React.PointerEvent) {
    const el = drawerRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    dragRef.current = {
      startY: e.clientY,
      startPct: drawerOpen ? 0 : 100,
      lastY: e.clientY,
      lastT: performance.now(),
      velocity: 0,
      heightPx: el.getBoundingClientRect().height,
    };
    setDrawerTransform(drawerOpen ? 0 : 100, false); // cancel any in-flight snap animation
  }

  function handleHandlePointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaPct = ((e.clientY - drag.startY) / drag.heightPx) * 100;
    const pct = Math.min(100, Math.max(0, drag.startPct + deltaPct));
    setDrawerTransform(pct, false);

    const now = performance.now();
    const dt = now - drag.lastT;
    if (dt > 0) drag.velocity = (e.clientY - drag.lastY) / dt;
    drag.lastY = e.clientY;
    drag.lastT = now;
  }

  function handleHandlePointerUp(e: React.PointerEvent) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    drawerRef.current?.releasePointerCapture(e.pointerId);

    const deltaPct = ((e.clientY - drag.startY) / drag.heightPx) * 100;
    const currentPct = Math.min(100, Math.max(0, drag.startPct + deltaPct));
    const shouldOpen =
      Math.abs(drag.velocity) > DRAG_VELOCITY_THRESHOLD
        ? drag.velocity < 0 // fast flick: honor direction over position
        : currentPct < DRAG_POSITION_SNAP_THRESHOLD;

    if (shouldOpen) openDrawer();
    else closeDrawer();
  }

  // Auto-open: "chega um card de correção (o aluno precisa ver a grafia
  // certa)" — fires only on a NEW entry, not on every re-render/re-mount.
  const prevEntriesLengthRef = useRef(entries.length);
  useEffect(() => {
    if (entries.length > prevEntriesLengthRef.current) {
      const newest = entries[entries.length - 1];
      if (newest?.role === "tutor" && newest.response.correction) {
        openDrawer();
      }
    }
    prevEntriesLengthRef.current = entries.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  // Floating caption: last tutor line only, cross-faded 200ms on change —
  // see the CSS transition on .mobile-caption-float's opacity.
  const captionText = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.role === "tutor") {
        const { english, portuguese } = entry.response.speech;
        return [english, portuguese].filter((s) => s.trim()).join(" ");
      }
    }
    return undefined;
  }, [entries]);

  const [captionVisible, setCaptionVisible] = useState(true);
  useEffect(() => {
    setCaptionVisible(false);
    const t = window.setTimeout(() => setCaptionVisible(true), 20);
    return () => window.clearTimeout(t);
  }, [captionText]);

  return (
    <div className="mobile-screen">
      <div className="mobile-avatar-fullscreen" onClick={() => drawerOpen && closeDrawer()}>
        <Avatar engine={avatarEngine} />
      </div>

      <div className="mobile-float-header">
        <div className="mobile-float-title">{branding.productName}</div>
        {started && <LessonTimer totalSeconds={totalSeconds} remainingSeconds={remainingSeconds} />}
      </div>

      {started && showTimeUpNotice && !lessonComplete && (
        <div className="mobile-time-notice-float">{branding.copy.sessionTimeUpNotice}</div>
      )}

      {!started && (
        <div className="mobile-login">
          <div className="intro-title">{branding.copy.demoLoginTitle}</div>
          <div className="unit-list">
            {demoStudents.map((student) => (
              <button
                key={student.id}
                type="button"
                className="btn btn-ghost unit-btn"
                onClick={() => onStudentPick(student)}
              >
                {student.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {started && (
        <>
          {captionText && (
            <div
              className="mobile-caption-float"
              style={{ opacity: captionVisible ? 1 : 0 }}
              onClick={openDrawer}
            >
              {captionText}
            </div>
          )}

          {!drawerOpen && (
            <div className="mobile-avatar-controls">
              <ForceSendButton
                label={branding.copy.forceSendButton}
                listeningLabel={branding.copy.forceSendWhileListening}
                isListening={characterState === "listening"}
                onClick={handleTalkClick}
              />
              <TipsPanel hint={currentHint} lesson={currentLesson} attention={tipsAttention} onBlinkEnd={onTipsBlinkEnd} />
            </div>
          )}

          {/* transform is owned entirely by imperative DOM writes (see
              setDrawerTransform) — deliberately NOT a React `style` prop.
              A re-render mid-drag or mid-snap-animation (e.g. the session
              timer ticking every second) would otherwise make React
              reconcile this element's inline style back to a value
              computed from `drawerOpen` alone, discarding whatever
              position the user's finger or the snap animation is
              currently at and making the drawer visibly jump. The CSS
              class's own `transform: translateY(100%)` default (see
              globals.css) covers the very first paint, before any JS has
              run, since drawerOpen starts false. */}
          <div className="mobile-drawer" ref={drawerRef}>
            <div
              className="mobile-drawer-handle"
              onClick={() => (drawerOpen ? closeDrawer() : openDrawer())}
              onPointerDown={handleHandlePointerDown}
              onPointerMove={handleHandlePointerMove}
              onPointerUp={handleHandlePointerUp}
              onPointerCancel={handleHandlePointerUp}
            >
              <span className="mobile-drawer-handle-bar" />
            </div>

            <div className="mobile-drawer-content">
              <ChatLog entries={entries} compact />

              <form className="mobile-drawer-input-row" onSubmit={onSubmit}>
                <input
                  className="chat-input"
                  placeholder={branding.copy.chatPlaceholder}
                  value={inputValue}
                  onChange={onInputChange}
                  onFocus={openDrawer}
                  autoComplete="off"
                />
                <button className="btn btn-primary" type="submit">
                  Enviar
                </button>
              </form>
            </div>
          </div>
        </>
      )}

      {lessonComplete && currentLesson && (
        <LessonCompleteCard
          lessonCode={currentLesson.lessonCode}
          lessonTitle={currentLesson.title}
          durationMinutes={currentLesson.durationMinutes}
          onClose={onEndLesson}
        />
      )}
    </div>
  );
}
