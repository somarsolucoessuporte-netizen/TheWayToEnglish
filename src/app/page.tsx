"use client";

import { useEffect, useMemo, useState } from "react";
import { branding } from "@/app-config/branding";
import { TUTOR_SYSTEM_PROMPT } from "@/app-config/persona";
import { DEMO_STUDENTS, type DemoStudent } from "@/app-config/demo-students";
import { getLessonByCode, type CurriculumLesson } from "@/app-config/curriculum";
import { aiProvider, speechProvider, sttProvider } from "@/app-config/providers";
import { AvatarEngine } from "@/core/avatar-engine/AvatarEngine";
import { CharacterStateMachine, type CharacterState } from "@/core/character-state-machine/stateMachine";
import { ConversationOrchestrator, type ChatEntry } from "@/core/conversation/orchestrator";
import { Avatar } from "@/components/Avatar";
import { ChatLog } from "@/components/ChatLog";
import { ForceSendButton } from "@/components/ForceSendButton";
import { StatusPills } from "@/components/StatusPills";
import { TipsPanel } from "@/components/TipsPanel";

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
    setCurrentLesson(getLessonByCode(student.currentLesson));
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

  // Avatar sprite stays on "listening" throughout the transcription gap
  // (see orchestrator.onTranscribing) — only the text label changes, so
  // the wait for a batch STT provider's upload doesn't read as a freeze.
  const stateLabel =
    transcribing && characterState === "listening" ? branding.copy.stateTranscribing : STATE_LABELS[characterState];

  return (
    <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
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
                    label={characterState === "listening" ? branding.copy.forceSendWhileListening : branding.copy.forceSendButton}
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
            <TipsPanel lesson={currentLesson} />
          </div>

          <ChatLog entries={entries} />

          <form className="chat-form" onSubmit={handleSubmit}>
            <input
              className="chat-input"
              placeholder={branding.copy.chatPlaceholder}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
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
