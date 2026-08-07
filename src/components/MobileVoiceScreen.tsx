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

/** Must match --caption-line-height in globals.css — used to compute the
 * 3-line height budget when measuring real line wraps for caption
 * pagination (see computeCaptionPages). */
const CAPTION_LINE_HEIGHT_PX = 21;
/** +1px of slack for subpixel rounding when comparing a measured
 * scrollHeight against the exact 3-line budget. */
const CAPTION_MAX_HEIGHT_PX = CAPTION_LINE_HEIGHT_PX * 3 + 1;

interface CaptionPage {
  /** Index of this page's first word within the full, combined (english
   * words then portuguese words) word sequence for the current tutor
   * entry — lets the reveal-driven render below figure out which page
   * the most recently revealed word falls into. */
  startWordIndex: number;
  words: string[];
}

/** Splits `words` into pages that each fit within a 3-line block at the
 * caption's real rendered width, using `measureEl` (see
 * .mobile-caption-measure) to grow a candidate line by line and check its
 * true wrapped height — this is the only reliable way to know where a
 * line actually breaks for a given font/width without reimplementing the
 * browser's own text-wrapping algorithm. Never truncates: a question that
 * genuinely needs more than 3 lines gets a 2nd (3rd, ...) page instead of
 * losing content, per the "nunca cortar instrução" requirement. */
function computeCaptionPages(words: string[], measureEl: HTMLDivElement): CaptionPage[] {
  if (words.length === 0) return [];
  const pages: CaptionPage[] = [];
  let currentWords: string[] = [];
  let currentStart = 0;

  for (let i = 0; i < words.length; i++) {
    const candidate = [...currentWords, words[i]];
    measureEl.textContent = candidate.join(" ");
    if (measureEl.scrollHeight > CAPTION_MAX_HEIGHT_PX && currentWords.length > 0) {
      pages.push({ startWordIndex: currentStart, words: currentWords });
      currentStart = i;
      currentWords = [words[i]];
    } else {
      currentWords = candidate;
    }
  }
  pages.push({ startWordIndex: currentStart, words: currentWords });
  return pages;
}

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
  currentHints,
  hintLevel,
  onHintReveal,
  tipsAttention,
  onTipsBlinkEnd,
  inputValue,
  onInputChange,
  onSubmit,
  lessonComplete,
  onEndLesson,
  micAmplitude,
  transcribing,
  shakeTrigger,
  onForceReset,
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
  currentHints: string[] | undefined;
  hintLevel: number;
  onHintReveal: () => void;
  tipsAttention: TipsAttention;
  onTipsBlinkEnd: () => void;
  inputValue: string;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (e: React.FormEvent) => void;
  lessonComplete: boolean;
  onEndLesson: () => void;
  micAmplitude: number;
  transcribing: boolean;
  shakeTrigger: number;
  onForceReset: () => void;
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
  // see the CSS transition on .mobile-caption-float's opacity. Respects
  // the same pending/reveal state as ChatLog (see orchestrator's
  // pushPendingTutorEntry/updateReveal): while pending, there's nothing to
  // caption yet (the avatar is still "thinking"), and once speech starts,
  // only the words revealed so far show — otherwise the caption would leak
  // the tutor's full line onto the screen before she's actually said it,
  // the exact "text before voice" problem this sync exists to fix.
  const lastTutorEntryIndex = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].role === "tutor") return i;
    }
    return undefined;
  }, [entries]);

  // The FULL text for the current tutor turn (english words, then
  // portuguese words — same order the reveal plays them in), independent
  // of how much has actually been revealed so far. Used only to precompute
  // page boundaries ahead of time (see the pagination effect below) — it
  // is NEVER rendered directly, so knowing it early (even while `pending`)
  // doesn't leak anything to the student.
  const fullCaptionWords = useMemo(() => {
    if (lastTutorEntryIndex === undefined) return [];
    const entry = entries[lastTutorEntryIndex];
    if (entry.role !== "tutor") return [];
    const englishWords = entry.response.speech.english.trim().split(/\s+/).filter(Boolean);
    const portugueseWords = entry.response.speech.portuguese.trim().split(/\s+/).filter(Boolean);
    return [...englishWords, ...portugueseWords];
  }, [entries, lastTutorEntryIndex]);

  // Paginated once per NEW tutor entry (see computeCaptionPages) — not on
  // every revealed word, since the full text (and therefore the page
  // breaks) is already fixed the moment the entry exists; only which page
  // is CURRENTLY SHOWN changes as words reveal (see revealedWordCount
  // below), which is cheap array math, not a DOM remeasure.
  const measureRef = useRef<HTMLDivElement>(null);
  const [captionPages, setCaptionPages] = useState<CaptionPage[]>([]);
  useEffect(() => {
    const measureEl = measureRef.current;
    if (!measureEl || fullCaptionWords.length === 0) {
      setCaptionPages([]);
      return;
    }
    setCaptionPages(computeCaptionPages(fullCaptionWords, measureEl));
    // Deliberately keyed on lastTutorEntryIndex alone, not fullCaptionWords
    // — the words for a given entry index never change after the entry is
    // created, so re-measuring on every reveal tick (which produces a new
    // `entries` array reference, and would recompute fullCaptionWords'
    // memo identity too) would be pure waste.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastTutorEntryIndex]);

  const revealedWordCount = useMemo(() => {
    if (lastTutorEntryIndex === undefined) return 0;
    const entry = entries[lastTutorEntryIndex];
    if (entry.role !== "tutor" || entry.pending) return 0;
    // No reveal state at all (e.g. a scripted forceAnnounce entry, which
    // skips the reveal machinery) means "show everything immediately".
    if (!entry.reveal) return fullCaptionWords.length;
    return entry.reveal.englishWordsShown + entry.reveal.portugueseWordsShown;
  }, [entries, lastTutorEntryIndex, fullCaptionWords.length]);

  // Which page the most recently revealed word falls into, and how much
  // of THAT page's text to show — words already revealed on an earlier
  // page are simply gone once the boundary is crossed (a hard page swap,
  // not a scroll), matching "mostra bloco 1 → avança quando o TTS chega
  // no próximo segmento".
  const pageText = useMemo(() => {
    if (captionPages.length === 0 || revealedWordCount === 0) return undefined;
    let page = captionPages[0];
    for (const candidate of captionPages) {
      if (candidate.startWordIndex < revealedWordCount) page = candidate;
      else break;
    }
    const wordsRevealedInPage = Math.min(page.words.length, revealedWordCount - page.startWordIndex);
    return page.words.slice(0, wordsRevealedInPage).join(" ") || undefined;
  }, [captionPages, revealedWordCount]);

  // Fades in exactly once per tutor entry, the moment its first word
  // appears — NOT on every subsequent word or page turn (pageText itself
  // changes on every revealed word, which would otherwise flicker the
  // opacity constantly instead of fading in smoothly once).
  const [captionVisible, setCaptionVisible] = useState(true);
  const fadedInForIndexRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!pageText || fadedInForIndexRef.current === lastTutorEntryIndex) return;
    fadedInForIndexRef.current = lastTutorEntryIndex;
    setCaptionVisible(false);
    const t = window.setTimeout(() => setCaptionVisible(true), 20);
    return () => window.clearTimeout(t);
  }, [pageText, lastTutorEntryIndex]);

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
          {/* Always rendered (space reserved for a full 3-line block via
              .mobile-caption-wrap's min/max-height — see globals.css) so
              the Falar button below it never jumps position between an
              empty turn and a 3-line one. The text itself only shows once
              there's something revealed to show (pageText undefined
              otherwise), same as before. */}
          <div className="mobile-caption-wrap" onClick={openDrawer}>
            {pageText && (
              <p className="mobile-caption-float" style={{ opacity: captionVisible ? 1 : 0 }}>
                {pageText}
              </p>
            )}
          </div>
          {/* Invisible measuring probe for computeCaptionPages — see its
              doc comment and the .mobile-caption-measure CSS rule. Never
              shown; textContent is written to it imperatively. */}
          <div ref={measureRef} className="mobile-caption-measure" aria-hidden="true" />

          {!drawerOpen && <div className="dock-scrim" />}

          {!drawerOpen && (
            <div className="mobile-avatar-controls">
              <ForceSendButton
                label={branding.copy.forceSendButton}
                listeningLabel={branding.copy.forceSendWhileListening}
                isListening={characterState === "listening"}
                processing={transcribing}
                onClick={handleTalkClick}
                onLongPress={onForceReset}
                amplitude={micAmplitude}
                shakeTrigger={shakeTrigger}
              />
              <TipsPanel
                hints={currentHints}
                hintLevel={hintLevel}
                onHintReveal={onHintReveal}
                lesson={currentLesson}
                attention={tipsAttention}
                onBlinkEnd={onTipsBlinkEnd}
              />
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

              <footer className="mobile-footer-credit">{branding.copy.mobileFooter}</footer>
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
