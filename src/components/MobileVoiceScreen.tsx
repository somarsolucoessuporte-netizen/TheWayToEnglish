"use client";

import { branding } from "@/app-config/branding";
import type { CurriculumLesson } from "@/app-config/curriculum";
import type { DemoStudent } from "@/app-config/demo-students";
import type { AvatarEngine } from "@/core/avatar-engine/AvatarEngine";
import type { CharacterState } from "@/core/character-state-machine/stateMachine";
import type { ChatEntry } from "@/core/conversation/orchestrator";
import type { TutorResponse } from "@/core/ai/TutorResponse";
import { Avatar } from "./Avatar";
import { ChatLog } from "./ChatLog";
import { ForceSendButton } from "./ForceSendButton";
import { LessonCompleteCard } from "./LessonCompleteCard";
import { LessonTimer } from "./LessonTimer";
import { MiniCorrectionCard } from "./MiniCorrectionCard";
import { TipsPanel, type TipsAttention } from "./TipsPanel";

/**
 * Voice-first mobile layout (<768px — see useIsMobile): the avatar fills
 * most of the screen, the tutor's last line shows as a video-style caption
 * (not a chat log), and the Falar button is the biggest thing on screen.
 * The full conversation history and the text input both move behind the
 * "💬 Conversa" sheet — reading is the fallback here, not the main path.
 * Desktop keeps the original side-by-side layout untouched (see page.tsx).
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
  lastTutorResponse,
  entries,
  currentLesson,
  currentHint,
  tipsAttention,
  onTipsBlinkEnd,
  inputValue,
  onInputChange,
  onSubmit,
  chatOpen,
  onChatOpenChange,
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
  lastTutorResponse: TutorResponse | undefined;
  entries: ChatEntry[];
  currentLesson: CurriculumLesson | undefined;
  currentHint: string | undefined;
  tipsAttention: TipsAttention;
  onTipsBlinkEnd: () => void;
  inputValue: string;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (e: React.FormEvent) => void;
  chatOpen: boolean;
  onChatOpenChange: (open: boolean) => void;
  lessonComplete: boolean;
  onEndLesson: () => void;
}) {
  return (
    <div className="mobile-screen">
      <div className="mobile-top-bar">
        {started ? (
          <LessonTimer totalSeconds={totalSeconds} remainingSeconds={remainingSeconds} />
        ) : (
          <div className="mobile-top-bar-spacer" />
        )}
        <button
          type="button"
          className="mobile-chat-toggle"
          onClick={() => onChatOpenChange(true)}
          aria-label="Abrir conversa"
        >
          💬 Conversa
        </button>
      </div>

      {started && showTimeUpNotice && !lessonComplete && (
        <div className="session-time-notice">{branding.copy.sessionTimeUpNotice}</div>
      )}

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
        <div className="mobile-below-avatar">
          {lastTutorResponse && (
            <p className="mobile-caption">
              {/* Same order as the spoken order — see ChatLog's matching
                  comment on why a correction reverses it. */}
              {lastTutorResponse.correction ? (
                <>
                  {lastTutorResponse.speech.portuguese}
                  {lastTutorResponse.speech.portuguese && lastTutorResponse.speech.english ? " " : ""}
                  {lastTutorResponse.speech.english}
                </>
              ) : (
                <>
                  {lastTutorResponse.speech.english}
                  {lastTutorResponse.speech.english && lastTutorResponse.speech.portuguese ? " " : ""}
                  {lastTutorResponse.speech.portuguese}
                </>
              )}
            </p>
          )}

          {lastTutorResponse?.correction && <MiniCorrectionCard correction={lastTutorResponse.correction} />}

          <div className="mobile-talk-wrap">
            <ForceSendButton
              label={branding.copy.forceSendButton}
              listeningLabel={branding.copy.forceSendWhileListening}
              isListening={characterState === "listening"}
              onClick={onTalkClick}
            />
          </div>
        </div>
      )}

      {lessonComplete && currentLesson && (
        <LessonCompleteCard
          lessonCode={currentLesson.lessonCode}
          lessonTitle={currentLesson.title}
          durationMinutes={currentLesson.durationMinutes}
          onClose={onEndLesson}
        />
      )}

      {chatOpen && (
        <div className="mobile-sheet-overlay" onClick={() => onChatOpenChange(false)}>
          <div className="mobile-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="chat-header">
              <div>
                <div className="chat-title">{branding.copy.chatTitle}</div>
                <div className="chat-subtitle">{branding.copy.chatSubtitle}</div>
              </div>
              <TipsPanel hint={currentHint} lesson={currentLesson} attention={tipsAttention} onBlinkEnd={onTipsBlinkEnd} />
              <button
                type="button"
                className="mobile-sheet-close"
                onClick={() => onChatOpenChange(false)}
                aria-label="Fechar"
              >
                ×
              </button>
            </div>

            <ChatLog entries={entries} />

            <form className="chat-form" onSubmit={onSubmit}>
              <input
                className="chat-input"
                placeholder={branding.copy.chatPlaceholder}
                value={inputValue}
                onChange={onInputChange}
                autoComplete="off"
              />
              <button className="btn btn-primary" type="submit">
                Enviar
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
