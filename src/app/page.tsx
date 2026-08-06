"use client";

import { useEffect, useMemo, useState } from "react";
import { branding } from "@/app-config/branding";
import { TUTOR_SYSTEM_PROMPT } from "@/app-config/persona";
import { DEMO_STUDENTS, type DemoStudent } from "@/app-config/demo-students";
import { aiProvider, speechProvider, sttProvider } from "@/app-config/providers";
import { AvatarEngine } from "@/core/avatar-engine/AvatarEngine";
import { CharacterStateMachine, type CharacterState } from "@/core/character-state-machine/stateMachine";
import { ConversationOrchestrator, type ChatEntry } from "@/core/conversation/orchestrator";
import { Avatar } from "@/components/Avatar";
import { ChatLog } from "@/components/ChatLog";
import { ForceSendButton } from "@/components/ForceSendButton";
import { StatusPills } from "@/components/StatusPills";
import { TipsPanel, type TipsAttention } from "@/components/TipsPanel";

/** How long the tutor must sit idle (turn over, student not yet responding)
 * before the tips button starts drawing attention to itself. */
const TIPS_EXPAND_AFTER_MS = 8000;
const TIPS_BLINK_AFTER_MS = 15000;

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

    fetch("/api/chat")
      .then((r) => setConnected(r.ok))
      .catch(() => setConnected(false));

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
    setStarted(true);
    await orchestrator.startLesson({ studentName: student.name, currentLessonCode: student.currentLesson });
  }

  async function handleTalkClick() {
    const isListening = characterState === "listening";
    console.log("[voice] botão Falar clicado");
    console.log("[voice] estado atual:", characterState);
    console.log("[voice] isListening:", isListening);
    if (isListening) {
      await orchestrator.stopListening(); // force-send early
    } else {
      await orchestrator.startListening(); // manual kick-off — covers cases where auto-VAD hasn't started yet
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
              attention={tipsAttention}
              onBlinkEnd={() => setTipsAttention("expanded")}
            />
          </div>

          <ChatLog entries={entries} />

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
    </main>
  );
}
