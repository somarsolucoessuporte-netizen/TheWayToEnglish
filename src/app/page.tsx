"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { branding } from "@/app-config/branding";
import { TUTOR_SYSTEM_PROMPT } from "@/app-config/persona";
import { DEMO_STUDENTS, type DemoStudent } from "@/app-config/demo-students";
import { getLessonByCode, type CurriculumLesson } from "@/app-config/curriculum";
import { aiProvider, speechProvider, sttProvider } from "@/app-config/providers";
import { AvatarEngine } from "@/core/avatar-engine/AvatarEngine";
import { preloadAvatarSprites } from "@/core/avatar-engine/preloadSprites";
import { waitForVoices } from "@/core/speech/waitForVoices";
import { CharacterStateMachine, type CharacterState } from "@/core/character-state-machine/stateMachine";
import { ConversationOrchestrator, type ChatEntry } from "@/core/conversation/orchestrator";
import { Avatar } from "@/components/Avatar";
import { ChatLog } from "@/components/ChatLog";
import { ForceSendButton } from "@/components/ForceSendButton";
import { LessonCompleteCard } from "@/components/LessonCompleteCard";
import { LessonTimer } from "@/components/LessonTimer";
import { LoadingScreen } from "@/components/LoadingScreen";
import { StatusPills } from "@/components/StatusPills";
import { TipsPanel, type TipsAttention } from "@/components/TipsPanel";

/** Lessons without an explicit durationMinutes (shouldn't happen with the
 * current curriculum data, but a demo prototype's JSON is hand-edited) get
 * this instead of the timer silently running forever. */
const DEFAULT_LESSON_DURATION_MIN = 15;
/** Fires the tutor's scripted "wrap up" heads-up once this many seconds
 * remain — matches persona.ts's TIME MANAGEMENT section. */
const TIME_WARNING_THRESHOLD_SECONDS = 180;

/** How long the tutor must sit idle (turn over, student not yet responding)
 * before the tips button starts drawing attention to itself. */
const TIPS_EXPAND_AFTER_MS = 8000;
const TIPS_BLINK_AFTER_MS = 15000;

const HEALTH_CHECK_TIMEOUT_MS = 5000;
/** How long the loading screen's fade-out (and the app's fade-in behind
 * it) take — must match .loading-screen's transition and .app-fade-in's
 * animation duration in globals.css. */
const BOOT_FADE_MS = 400;
/** Small buffer after the demo-student click, before the tutor's opening
 * line starts — gives the avatar's just-mounted <img> elements a beat to
 * finish painting (they're already preloaded/decoded by the boot gate, but
 * layout/paint of a freshly-mounted element can still lag a frame or two)
 * so the first line of speech never starts before the avatar is visually
 * settled. */
const PRE_KICKOFF_DELAY_MS = 500;

/** GET /api/chat as a lightweight readiness probe — same endpoint the app
 * already used for the "Conectado"/"Sem conexão" pill, just with a hard
 * timeout so a stalled request can't hang the loading screen forever. */
async function checkApiHealth(timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("/api/chat", { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

const STATE_LABELS: Record<CharacterState, string> = {
  idle: branding.copy.stateIdle,
  listening: branding.copy.stateListening,
  thinking: branding.copy.stateThinking,
  speaking: branding.copy.stateSpeaking,
  praise: "😊",
  correction: "💡",
  error: branding.copy.genericError,
};

export default function Page() {
  const avatarEngine = useMemo(() => new AvatarEngine(), []);
  const stateMachine = useMemo(() => new CharacterStateMachine(), []);
  const orchestrator = useMemo(
    () =>
      new ConversationOrchestrator({
        speech: speechProvider,
        stt: sttProvider,
        ai: aiProvider,
        avatar: avatarEngine,
        stateMachine,
        systemPrompt: TUTOR_SYSTEM_PROMPT,
      }),
    [avatarEngine, stateMachine]
  );

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [characterState, setCharacterState] = useState<CharacterState>("idle");
  const [transcribing, setTranscribing] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [inputValue, setInputValue] = useState("");

  // Single-step demo login: picks a canned student profile (name + where
  // they are in the course) in place of real authentication. See
  // app-config/demo-students.ts — swap this step out once real login and
  // the school's academic system are wired in.
  const [started, setStarted] = useState(false);
  const [currentLesson, setCurrentLesson] = useState<CurriculumLesson | undefined>(undefined);

  // Lesson timer: counts down from the lesson's durationMinutes, but only
  // while the student could actually be interacting (see the ticking
  // effect below) — time spent waiting on the tutor doesn't count against
  // them. totalSeconds doubles as "has a lesson actually started" (0 means
  // no lesson picked yet), which the warning/completion effects rely on.
  const [totalSeconds, setTotalSeconds] = useState(0);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [lessonComplete, setLessonComplete] = useState(false);

  useEffect(() => {
    if (!started || lessonComplete) return;
    if (characterState !== "idle" && characterState !== "listening") return;
    const id = window.setInterval(() => {
      setRemainingSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [started, lessonComplete, characterState]);

  useEffect(() => {
    if (!started || lessonComplete || totalSeconds === 0) return;
    if (remainingSeconds <= TIME_WARNING_THRESHOLD_SECONDS && remainingSeconds > 0) {
      // announceTimeWarning() no-ops after its first real call, so it's
      // safe to "call again" on every tick while under the threshold.
      void orchestrator.announceTimeWarning();
    }
    if (remainingSeconds <= 0) {
      setLessonComplete(true);
      void orchestrator.announceLessonComplete();
    }
  }, [remainingSeconds, started, lessonComplete, totalSeconds, orchestrator]);

  function handleEndLesson() {
    orchestrator.reset();
    setStarted(false);
    setCurrentLesson(undefined);
    setLessonComplete(false);
    setTotalSeconds(0);
    setRemainingSeconds(0);
    setTipsAttention("normal");
  }

  // Boot gate: the avatar and chat never mount until the 9 sprites are
  // decoded, speechSynthesis has voices (or 2s passed), and /api/chat has
  // answered — mounting them earlier is what used to make the avatar and
  // audio try to start against half-loaded assets or a cold API. "fading"
  // is a brief transitional state: the loading screen fades out while the
  // just-mounted app fades in underneath it (see .loading-screen-fadeout /
  // .app-fade-in in globals.css).
  const [bootState, setBootState] = useState<"loading" | "fading" | "ready" | "error">("loading");

  const runBoot = useCallback(() => {
    setBootState("loading");
    let cancelled = false;

    (async () => {
      const [, , healthOk] = await Promise.all([
        preloadAvatarSprites(),
        waitForVoices(2000),
        checkApiHealth(HEALTH_CHECK_TIMEOUT_MS).then((ok) => {
          if (!cancelled) setConnected(ok);
          return ok;
        }),
      ]);
      if (cancelled) return;
      if (!healthOk) {
        setBootState("error");
        return;
      }
      setBootState("fading");
      window.setTimeout(() => {
        if (!cancelled) setBootState("ready");
      }, BOOT_FADE_MS);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => runBoot(), [runBoot]);

  // Tracks the current turn's hint (see TutorResponse.hint / persona.ts's
  // HINTS section) — real-time, tied to whatever the tutor just asked, not
  // a static per-lesson list. Recomputed from `entries` so it's never out
  // of sync with what's actually on screen.
  const currentHint = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.role === "tutor") return entry.response.hint;
    }
    return undefined;
  }, [entries]);

  // Tips-button attention animation: only counts idle time that comes right
  // after the tutor finishes speaking (never while listening/thinking/
  // speaking) — resets the moment characterState leaves "idle", and the
  // effect re-arms fresh every time it re-enters "idle" (each transition
  // into idle is a new value, so this effect body reruns exactly once per
  // idle stretch, not on every render).
  const [tipsAttention, setTipsAttention] = useState<TipsAttention>("normal");

  useEffect(() => {
    if (characterState !== "idle") {
      setTipsAttention("normal");
      return;
    }
    const expandTimer = window.setTimeout(() => setTipsAttention("expanded"), TIPS_EXPAND_AFTER_MS);
    const blinkTimer = window.setTimeout(() => setTipsAttention("blinking"), TIPS_BLINK_AFTER_MS);
    return () => {
      window.clearTimeout(expandTimer);
      window.clearTimeout(blinkTimer);
    };
  }, [characterState]);

  useEffect(() => {
    const unsubEntries = orchestrator.onEntriesChange(setEntries);
    const unsubState = orchestrator.onStateChange(setCharacterState);
    const unsubError = orchestrator.onError((message) => console.error("[conversation]", message));
    const unsubApiStatus = orchestrator.onApiStatus(setConnected);
    const unsubTranscribing = orchestrator.onTranscribing(setTranscribing);

    return () => {
      unsubEntries();
      unsubState();
      unsubError();
      unsubApiStatus();
      unsubTranscribing();
    };
  }, [orchestrator]);

  async function handleStudentPick(student: DemoStudent) {
    // Unlocks speechSynthesis on browsers (notably iOS Safari) that require
    // the first utterance to originate from a user gesture — this click is
    // the first real user gesture in the whole flow.
    if ("speechSynthesis" in window) {
      const warmUp = new SpeechSynthesisUtterance(" ");
      warmUp.volume = 0;
      window.speechSynthesis.speak(warmUp);
    }
    const lesson = getLessonByCode(student.currentLesson);
    const seconds = (lesson?.durationMinutes ?? DEFAULT_LESSON_DURATION_MIN) * 60;
    setStarted(true);
    setCurrentLesson(lesson);
    setTotalSeconds(seconds);
    setRemainingSeconds(seconds);
    setLessonComplete(false);
    await new Promise((resolve) => window.setTimeout(resolve, PRE_KICKOFF_DELAY_MS));
    await orchestrator.startLesson({ studentName: student.name, currentLessonCode: student.currentLesson });
  }

  // The ONLY call site for orchestrator.startListening() in the whole app
  // — push-to-talk is a hard rule (see orchestrator.ts's comments): the
  // microphone opens on this explicit click and never on its own.
  async function handleTalkClick() {
    const isListening = characterState === "listening";
    if (isListening) {
      await orchestrator.stopListening(); // force-send early
    } else {
      await orchestrator.startListening(); // the one and only mic-open path
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = inputValue.trim();
    if (!text) return;
    setInputValue("");
    await orchestrator.sendTextMessage(text);
  }

  // Any interaction — a click anywhere, or the student starting to type —
  // cancels the attention animation immediately, per spec. Voice input is
  // covered separately: it flips characterState off "idle", which the
  // timer effect above already resets on its own.
  function resetTipsAttention() {
    setTipsAttention("normal");
  }

  // Avatar sprite stays on "listening" throughout the transcription gap
  // (see orchestrator.onTranscribing) — only the text label changes, so
  // the wait for a batch STT provider's upload doesn't read as a freeze.
  const stateLabel =
    transcribing && characterState === "listening" ? branding.copy.stateTranscribing : STATE_LABELS[characterState];

  return (
    <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }} onClick={resetTipsAttention}>
      {bootState !== "ready" && (
        <LoadingScreen status={bootState === "error" ? "error" : "loading"} fadingOut={bootState === "fading"} />
      )}

      {(bootState === "fading" || bootState === "ready") && (
        <div className={`app-shell${bootState === "fading" ? " app-fade-in" : ""}`}>
          <header className="topbar">
            <div className="brand">
              <div className="dot" />
              <div className="brand-text">
                <div className="title">{branding.productName}</div>
                <div className="subtitle">{branding.companyName}</div>
              </div>
            </div>
            <StatusPills connected={connected} stateLabel={stateLabel} />
          </header>

          <div className="main">
            <section className="stage">
              <Avatar engine={avatarEngine} />

              {!started && (
                <div className="intro-overlay">
                  <div className="intro-card">
                    <div className="intro-title">{branding.copy.demoLoginTitle}</div>
                    <div className="unit-list">
                      {DEMO_STUDENTS.map((student) => (
                        <button
                          key={student.id}
                          type="button"
                          className="btn btn-ghost unit-btn"
                          onClick={() => handleStudentPick(student)}
                        >
                          {student.name}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {started && (
                <div className="avatar-ui">
                  <div className="avatar-state">{stateLabel}</div>
                  {characterState !== "speaking" && (
                    <div className="avatar-actions">
                      <ForceSendButton
                        label={branding.copy.forceSendButton}
                        listeningLabel={branding.copy.forceSendWhileListening}
                        isListening={characterState === "listening"}
                        onClick={handleTalkClick}
                      />
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="chat">
              <div className="chat-header">
                <div>
                  <div className="chat-title">{branding.copy.chatTitle}</div>
                  <div className="chat-subtitle">{branding.copy.chatSubtitle}</div>
                </div>
                <TipsPanel
                  hint={currentHint}
                  lesson={currentLesson}
                  attention={tipsAttention}
                  onBlinkEnd={() => setTipsAttention("expanded")}
                />
              </div>

              {started && <LessonTimer totalSeconds={totalSeconds} remainingSeconds={remainingSeconds} />}

              <ChatLog entries={entries} />

              {lessonComplete && currentLesson && (
                <LessonCompleteCard
                  lessonCode={currentLesson.lessonCode}
                  lessonTitle={currentLesson.title}
                  durationMinutes={currentLesson.durationMinutes}
                  onClose={handleEndLesson}
                />
              )}

              <form className="chat-form" onSubmit={handleSubmit}>
                <input
                  className="chat-input"
                  placeholder={branding.copy.chatPlaceholder}
                  value={inputValue}
                  onChange={(e) => {
                    setInputValue(e.target.value);
                    resetTipsAttention();
                  }}
                  autoComplete="off"
                />
                <button className="btn btn-primary" type="submit">
                  Enviar
                </button>
              </form>

              <footer className="footer">{branding.copy.footer}</footer>
            </section>
          </div>
        </div>
      )}
    </main>
  );
}
