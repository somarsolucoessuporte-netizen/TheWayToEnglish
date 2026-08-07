"use client";

import { useState } from "react";
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

/**
 * Mobile layout (<768px — see components/useIsMobile.ts): the chat log is
 * always visible and always scrollable, never hidden behind a "Conversa"
 * button — this is a language lesson, the student needs to see the
 * spelling of what's being said, not just hear it. Only the avatar (fixed,
 * 40vh), the time bar, and the Falar/tips/keyboard footer are pinned; the
 * transcript in between is the only thing that scrolls. Desktop keeps the
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
  // Local to this component, not lifted to page.tsx — nothing outside the
  // footer/input-row pair needs to know whether the keyboard is open.
  const [textInputOpen, setTextInputOpen] = useState(false);

  return (
    <div className="mobile-screen">
      <div className="mobile-avatar-wrap">
        <Avatar engine={avatarEngine} />
      </div>

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
          <div className="mobile-timer-row">
            <LessonTimer totalSeconds={totalSeconds} remainingSeconds={remainingSeconds} />
          </div>
          {showTimeUpNotice && !lessonComplete && (
            <div className="session-time-notice">{branding.copy.sessionTimeUpNotice}</div>
          )}

          <ChatLog entries={entries} compact />

          {textInputOpen && (
            <form
              className="mobile-input-row"
              onSubmit={(e) => {
                onSubmit(e);
                setTextInputOpen(false);
              }}
            >
              <input
                className="chat-input"
                placeholder={branding.copy.chatPlaceholder}
                value={inputValue}
                onChange={onInputChange}
                autoComplete="off"
                autoFocus
              />
              <button className="btn btn-primary" type="submit">
                Enviar
              </button>
            </form>
          )}

          <div className="mobile-footer">
            <ForceSendButton
              label={branding.copy.forceSendButton}
              listeningLabel={branding.copy.forceSendWhileListening}
              isListening={characterState === "listening"}
              onClick={onTalkClick}
            />
            <div className="mobile-footer-icons">
              <TipsPanel hint={currentHint} lesson={currentLesson} attention={tipsAttention} onBlinkEnd={onTipsBlinkEnd} />
              <button
                type="button"
                className="mobile-footer-icon-btn"
                onClick={() => setTextInputOpen((open) => !open)}
                aria-label={textInputOpen ? "Fechar teclado" : "Digitar mensagem"}
                aria-pressed={textInputOpen}
              >
                ⌨️
              </button>
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
