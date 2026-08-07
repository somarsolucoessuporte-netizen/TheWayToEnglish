import type { TutorResponse } from "./TutorResponse";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIOptions {
  sessionId?: string;
  systemPrompt?: string;
  /** Language Whisper detected in the student's last voice message (raw,
   * whatever /api/stt reported — usually "en"/"pt" but not guaranteed;
   * omitted for typed messages), so the tutor can weigh the sandwich
   * method's Portuguese/English balance accordingly. */
  detectedLanguage?: string;
  /** Set once at session start (from the demo student selector), then
   * carried on every turn for the rest of the session so the tutor keeps
   * addressing the student by name and teaches at the level of their
   * actual current lesson — resolved server-side from the lesson code. */
  studentName?: string;
  currentLessonCode?: string;
  /** Set once the lesson timer (see LessonTimer / orchestrator.announceTimeWarning)
   * crosses the 3-minutes-remaining mark, and carried on every turn for the
   * rest of the session from then on — tells the tutor to actively steer
   * the conversation toward wrapping up instead of starting new ground. */
  timeWarning?: boolean;
  /** How many consecutive times, before this message, the student has
   * already failed the SAME correction target (see orchestrator's
   * pendingCorrectionWord/correctionAttemptCount tracking) — 0 for a fresh
   * mistake or when the last turn had no correction at all. Lets the
   * persona escalate (see ATTEMPT-BASED CORRECTION ESCALATION) instead of
   * repeating the identical correction indefinitely. */
  attemptCount?: number;
}

export interface AIProvider {
  send(messages: Message[], opts?: AIOptions): Promise<TutorResponse>;
}
