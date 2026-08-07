"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { branding } from "@/app-config/branding";
import { TUTOR_SYSTEM_PROMPT } from "@/app-config/persona";
import { DEMO_STUDENTS, type DemoStudent } from "@/app-config/demo-students";
import { getLessonByCode, type CurriculumLesson } from "@/app-config/curriculum";
import { aiProvider, speechProvider, sttProvider } from "@/app-config/providers";
import { AvatarEngine } from "@/core/avatar-engine/AvatarEngine";
import { preloadAllAvatarVideos } from "@/core/avatar-engine/preloadAvatarAssets";
import { checkAudioContextState, unlockAudioForIOS } from "@/core/audio/warmUpAudioContext";
import { isIOS } from "@/core/utils/platform";
import { warmUpTts } from "@/core/speech/warmUpTts";
import { debugLog, describeError, initGlobalErrorCapture, isDebugEnabled, setDebugStep } from "@/core/debug/debugStore";
import { DebugPanel } from "@/components/DebugPanel";
import { CharacterStateMachine, type CharacterState } from "@/core/character-state-machine/stateMachine";
import { ConversationOrchestrator, type ChatEntry } from "@/core/conversation/orchestrator";
import { prefetchGreeting, type PrefetchedGreeting } from "@/core/conversation/greetingPrefetch";
import { Avatar } from "@/components/Avatar";
import { ChatLog } from "@/components/ChatLog";
import { ErrorToast } from "@/components/ErrorToast";
import { ForceSendButton } from "@/components/ForceSendButton";
import { LessonCompleteCard } from "@/components/LessonCompleteCard";
import { LessonTimer } from "@/components/LessonTimer";
import { LoadingScreen } from "@/components/LoadingScreen";
import { MobileVoiceScreen, type MobileVoiceScreenHandle } from "@/components/MobileVoiceScreen";
import { StatusPills } from "@/components/StatusPills";
import { TipsPanel, type TipsAttention } from "@/components/TipsPanel";
import { useIsMobile } from "@/components/useIsMobile";

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

/** How long an orchestrator.onError message (see ErrorToast) stays
 * visible before auto-dismissing. */
const ERROR_TOAST_DURATION_MS = 4000;

const HEALTH_CHECK_TIMEOUT_MS = 5000;
/** How long the loading screen's fade-out (and the app's fade-in behind
 * it) take — must match .loading-screen's transition and .app-fade-in's
 * animation duration in globals.css. */
const BOOT_FADE_MS = 400;
/** Safety net: if the four boot steps below haven't ALL settled by this
 * point, stop waiting and show the "connection is slow, retry?" screen
 * instead of leaving the student staring at a progress bar forever. */
const BOOT_TIMEOUT_MS = 8000;
/** Small buffer after the demo-student click, before the tutor's opening
 * line starts — gives the avatar's just-mounted <video> elements a beat to
 * finish painting (they're already preloaded to canplaythrough by the boot
 * gate, but layout/paint of freshly-mounted elements can still lag a frame
 * or two) so the first line of speech never starts before the avatar is
 * visually settled. */
const PRE_KICKOFF_DELAY_MS = 500;

/** Debug-panel-only check (see core/debug/debugStore) — never part of the
 * boot gate itself, just informational: confirms the static fallback
 * frame every avatar <video poster> depends on (see Avatar.tsx) actually
 * loads on this device/connection. */
function checkPosterImage(): void {
  const startedAt = performance.now();
  setDebugStep("poster", "poster.jpg", "pending", "carregando...");
  const img = new Image();
  img.onload = () => {
    const ms = Math.round(performance.now() - startedAt);
    setDebugStep("poster", "poster.jpg", "ok", `carregado em ${ms}ms`);
  };
  img.onerror = () => {
    setDebugStep("poster", "poster.jpg", "error", "falhou ao carregar");
  };
  img.src = "/avatar/poster.jpg";
}

/** GET /api/chat as a lightweight readiness probe — same endpoint the app
 * already used for the "Conectado"/"Sem conexão" pill, just with a hard
 * timeout so a stalled request can't hang the loading screen forever.
 * Reports timing/status to the debug panel's checklist (see
 * core/debug/debugStore) unconditionally — cheap either way, and means
 * the log already has this by the time anyone adds ?debug=1. */
async function checkApiHealth(timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  setDebugStep("api-chat", "/api/chat", "pending", "aguardando...");
  try {
    const res = await fetch("/api/chat", { signal: controller.signal });
    const ms = Math.round(performance.now() - startedAt);
    setDebugStep("api-chat", "/api/chat", res.ok ? "ok" : "error", `${res.status} em ${ms}ms`);
    return res.ok;
  } catch (err) {
    const ms = Math.round(performance.now() - startedAt);
    setDebugStep("api-chat", "/api/chat", "error", `${describeError(err)} após ${ms}ms`);
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

/** The things the boot gate waits on, in parallel, before releasing the
 * app — see runBoot. Each flag flips true independently as its own step
 * settles, driving both the progress bar and the staged status text.
 * avatarVideos covers all 5 avatar clips together (see
 * preloadAllAvatarVideos) — they're preloaded as one batch, not tracked
 * individually, since the app has nothing meaningful to show for "3 of 5
 * ready" beyond the single "Carregando a professora..." status line.
 *
 * AudioContext is deliberately NOT one of these — a confirmed iPhone
 * diagnosis (via the ?debug=1 panel) showed it's a permanent deadlock as
 * a boot gate: iOS Safari only ever reports a freshly-created context as
 * "suspended" until a real user gesture resumes ONE, and nothing has been
 * touched yet during boot. Waiting on it hung the splash forever on every
 * iPhone. It isn't needed for anything else either — WhisperSTTProvider
 * and playCorrectSound each create their own AudioContext when actually
 * needed — so it's reported purely informationally on the debug panel
 * (see checkAudioContextState) instead of gating anything. */
interface BootAssets {
  avatarVideos: boolean;
  ttsWarm: boolean;
  chatHealth: boolean;
}

const INITIAL_BOOT_ASSETS: BootAssets = {
  avatarVideos: false,
  ttsWarm: false,
  chatHealth: false,
};

const BOOT_STEPS_TOTAL = Object.keys(INITIAL_BOOT_ASSETS).length;

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
  // 2000ms (not the default 1500) so the praise video (see Avatar.tsx) —
  // a one-shot reaction clip, not a loop — gets its full "fica visível
  // por 2 segundos" before reverting. Also applies to the "correction"
  // transient, which is harmless since it doesn't have a dedicated video
  // (falls back to idle — see AvatarEngine.getVideoState) and isn't
  // timing-sensitive the way praise is.
  const stateMachine = useMemo(() => new CharacterStateMachine({ transientDurationMs: 2000 }), []);
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

  // On-screen diagnostics (see components/DebugPanel.tsx) for ?debug=1 —
  // starts false (matching what the server would render, which is
  // nothing) and flips in the mount effect below, never during the
  // initial render itself, so hydration never has to reconcile a
  // client-only value against server output. Global error capture (see
  // initGlobalErrorCapture) starts unconditionally on mount regardless of
  // this flag — it's nearly free, and means errors before the panel is
  // ever looked at are already in the log the moment someone checks.
  const [debugEnabled, setDebugEnabled] = useState(false);
  useEffect(() => {
    initGlobalErrorCapture();
    setDebugEnabled(isDebugEnabled());
  }, []);

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [characterState, setCharacterState] = useState<CharacterState>("idle");
  const [transcribing, setTranscribing] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [inputValue, setInputValue] = useState("");
  // Real mic RMS while listening (see orchestrator.onAmplitude /
  // WhisperSTTProvider's VAD) — drives ForceSendButton's sound-wave bars
  // with actual voice amplitude. Stays 0 for an STT provider without a
  // real VAD (e.g. BrowserSTTProvider), which just means flat bars.
  const [micAmplitude, setMicAmplitude] = useState(0);
  // Visible feedback for orchestrator.onError (see ErrorToast) — auto-
  // dismisses so a stale message never lingers after the student's moved
  // on. A ref (not just clearing on the next message) is what lets a
  // SECOND error arriving mid-display restart the same 4s window instead
  // of inheriting whatever was left of the first one's timer.
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped every time a Falar click was silently ignored (orchestrator
  // busy) — see ForceSendButton's shakeTrigger prop.
  const [shakeTrigger, setShakeTrigger] = useState(0);
  // Pulses the Falar button's border for a few seconds right after the
  // "hear it, repeat it" drill's "Now you try." cue (see
  // orchestrator.onAwaitingRepeat) — see ForceSendButton's awaitingRepeat
  // prop. A ref (not just a bare timeout in the listener) is what lets a
  // second cue landing mid-pulse restart the same 3s window cleanly.
  const [awaitingRepeat, setAwaitingRepeat] = useState(false);
  const awaitingRepeatTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mobile's Falar button click needs to close the drawer first (see
  // MobileVoiceScreen) — the button itself is now a single page-level
  // instance (see .force-send-btn-dock below) shared by both layouts, so
  // this imperative handle is how it reaches into the mobile-only drawer.
  const mobileVoiceScreenRef = useRef<MobileVoiceScreenHandle>(null);


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
  // no lesson picked yet), which the warning effect relies on. The bar is
  // a visual reference only — it does NOT end the lesson on its own (see
  // showTimeUpNotice below and orchestrator.onLessonComplete): the lesson
  // only actually completes once every can-do goal has been demonstrated.
  const [totalSeconds, setTotalSeconds] = useState(0);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [lessonComplete, setLessonComplete] = useState(false);
  const [showTimeUpNotice, setShowTimeUpNotice] = useState(false);

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
    // Time running out is only a discreet heads-up now, not an end-of-lesson
    // trigger — the lesson keeps going until every can-do goal is done (see
    // orchestrator.onLessonComplete below).
    if (remainingSeconds <= 0) {
      setShowTimeUpNotice(true);
    }
  }, [remainingSeconds, started, lessonComplete, totalSeconds, orchestrator]);

  // The ONLY trigger for the lesson-complete card: every can-do goal for
  // the current lesson has been demonstrated (see orchestrator's
  // updateGoalProgress) — independent of however much time is left.
  useEffect(() => {
    return orchestrator.onLessonComplete(() => {
      setLessonComplete(true);
      void orchestrator.announceLessonComplete();
    });
  }, [orchestrator]);

  function handleEndLesson() {
    orchestrator.reset();
    setStarted(false);
    setCurrentLesson(undefined);
    setLessonComplete(false);
    setTotalSeconds(0);
    setRemainingSeconds(0);
    setShowTimeUpNotice(false);
    setTipsAttention("normal");
  }

  // Boot gate: the avatar and chat never mount until a real /api/tts
  // warm-up call (pre-empting the serverless cold start so the tutor's
  // first spoken line isn't the one that pays for it), a ready
  // AudioContext, and /api/chat answering 200 have all settled — mounting
  // earlier is what used to make the avatar and audio try to start
  // against a cold API. The 5 avatar clips preload independently in the
  // background (see runBoot) and are deliberately NOT part of this gate:
  // iOS Safari never signals video readiness without a user gesture, so
  // waiting on it here used to hang every iPhone student on this screen
  // until the timeout. "fading" is a brief transitional state: the
  // loading screen fades out while the just-mounted app fades in underneath it (see
  // .loading-screen-fadeout / .app-fade-in in globals.css). "timeout"
  // fires if boot is still incomplete after BOOT_TIMEOUT_MS — distinct
  // from "error" (a step definitively failed) even though both show a
  // retry screen, since nothing here actually rejected.
  const [bootState, setBootState] = useState<"loading" | "fading" | "ready" | "error" | "timeout">("loading");
  const [bootAssets, setBootAssets] = useState<BootAssets>(INITIAL_BOOT_ASSETS);

  // Per-student greeting prefetch (chat kickoff + its TTS audio), fired in
  // parallel during boot — see greetingPrefetch.ts and handleStudentPick,
  // which consumes and clears an entry the moment it's used. A ref, not
  // state: populating it should never trigger a re-render, and it must
  // survive independently of the boot gate's own progress (this is
  // deliberately NOT one of the BootAssets — the app must not wait on 3
  // extra chat+tts round trips just to become usable; a cache miss just
  // means startLesson falls back to its normal live call).
  const greetingCacheRef = useRef<Map<string, PrefetchedGreeting | null>>(new Map());

  const runBoot = useCallback(() => {
    setBootState("loading");
    setBootAssets(INITIAL_BOOT_ASSETS);
    greetingCacheRef.current.clear();
    for (const student of DEMO_STUDENTS) {
      void prefetchGreeting(student).then((greeting) => {
        greetingCacheRef.current.set(student.id, greeting);
      });
    }
    let settled = false; // true once either the timeout or Promise.all wins the race
    // Mirrors bootAssets without waiting on a render, so the timeout
    // handler below can log exactly which asset(s) never settled — see
    // "[splash] pendentes" below.
    const assetsSoFar: BootAssets = { ...INITIAL_BOOT_ASSETS };

    const markDone = (key: keyof BootAssets) => {
      if (settled) return; // a step finishing after timeout has nothing left to update
      assetsSoFar[key] = true;
      setBootAssets((prev) => ({ ...prev, [key]: true }));
    };

    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      const pending = (Object.keys(assetsSoFar) as (keyof BootAssets)[]).filter((key) => !assetsSoFar[key]);
      console.log("[splash] pendentes:", pending);
      setBootState("timeout");
    }, BOOT_TIMEOUT_MS);

    checkPosterImage();

    // Avatar video preload runs in the background, independent of the
    // release gate below — iOS Safari never fires a video's readiness
    // signal without a prior user gesture (see preloadAvatarAssets.ts), so
    // waiting on it here would hang every iPhone on this screen until the
    // timeout above. Each clip's own `poster` attribute (see Avatar.tsx)
    // already shows a static frame for the gap between mount and its real
    // data arriving — nothing else needs to wait on this. onStatus reports
    // each clip individually to the debug panel's checklist.
    for (const state of ["idle", "listening", "thinking", "speaking", "praise"] as const) {
      setDebugStep(`video:${state}`, `${state}.mp4`, "pending", "aguardando...");
    }
    void preloadAllAvatarVideos(6000, (state, status, detail) => {
      setDebugStep(`video:${state}`, `${state}.mp4`, status === "ok" ? "ok" : "error", detail ?? "");
    }).then(() => markDone("avatarVideos"));

    // Purely informational (see BootAssets's doc comment on why this is
    // NOT part of the gate below) — fire-and-forget, never awaited, never
    // blocks anything. "suspended" on iOS before any gesture is the
    // expected, normal result, not a failure — see the "info" DebugStatus.
    setDebugStep(
      "audio-ctx",
      "AudioContext",
      "info",
      `${checkAudioContextState()} (normal no iOS até um gesto real)`
    );

    (async () => {
      const ttsStartedAt = performance.now();
      setDebugStep("api-tts", "/api/tts", "pending", "aguardando...");
      const [, chatOk] = await Promise.all([
        // Best-effort: still drives the progress bar and status text, but
        // a failed pre-warm (missing API key, provider briefly down)
        // degrades to a per-turn voice error instead of blocking the
        // whole app from ever loading — /api/chat below is the only hard
        // gate, since without it there's no lesson at all.
        warmUpTts().then((ok) => {
          const ms = Math.round(performance.now() - ttsStartedAt);
          setDebugStep("api-tts", "/api/tts", ok ? "ok" : "error", `${ok ? "200" : "falhou"} em ${ms}ms`);
          markDone("ttsWarm");
        }),
        checkApiHealth(HEALTH_CHECK_TIMEOUT_MS).then((ok) => {
          setConnected(ok);
          markDone("chatHealth");
          return ok;
        }),
      ]);
      if (settled) return; // the 8s timeout already fired and took over
      settled = true;
      window.clearTimeout(timeoutId);
      if (!chatOk) {
        setBootState("error");
        return;
      }
      setBootState("fading");
      window.setTimeout(() => setBootState("ready"), BOOT_FADE_MS);
    })();

    return () => {
      settled = true;
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => runBoot(), [runBoot]);

  const bootDoneCount = Object.values(bootAssets).filter(Boolean).length;
  const bootProgressPct = Math.round((bootDoneCount / BOOT_STEPS_TOTAL) * 100);
  // Staged status text: which group of steps is still outstanding, in the
  // order the student sees them settle — voice (TTS warm-up) first, then
  // the chat connection. avatarVideos is deliberately NOT part of this
  // sequence: it's a background, best-effort preload (see runBoot) that
  // can legitimately never finish on iOS Safari without hanging the
  // status text on it — same reasoning as AudioContext no longer being
  // one of these flags at all (see BootAssets's doc comment). Once every
  // remaining flag is true this naturally lands on "Tudo pronto!",
  // covering the brief "fading" state too without needing a separate
  // branch for it.
  const bootStatusText = !bootAssets.ttsWarm
    ? branding.copy.bootLoadingVoice
    : !bootAssets.chatHealth
      ? branding.copy.bootConnecting
      : branding.copy.bootReady;

  // Tracks the current turn's 3-level hint ladder (see TutorResponse.hints
  // / persona.ts's HINTS LADDER section) — real-time, tied to whatever the
  // tutor just asked, not a static per-lesson list. Recomputed from
  // `entries` so it's never out of sync with what's actually on screen.
  // currentHintsEntryIndex identifies WHICH tutor turn currentHints came
  // from (not just its content), so the reveal-level effect below can
  // tell "the tutor asked a new question" apart from "the array is empty
  // both times" — content equality alone can't distinguish those.
  const currentHintsEntryIndex = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].role === "tutor") return i;
    }
    return undefined;
  }, [entries]);
  const currentHints = useMemo(() => {
    if (currentHintsEntryIndex === undefined) return undefined;
    const entry = entries[currentHintsEntryIndex];
    return entry.role === "tutor" ? entry.response.hints : undefined;
  }, [entries, currentHintsEntryIndex]);

  // How many of currentHints[] the student has revealed so far (0 = none
  // — the whole point of ASKING VS. HELPING is that nothing shows until
  // the student actively asks for it). Resets to 0 the instant a new
  // tutor turn arrives, regardless of whether it has hints at all.
  const [hintLevel, setHintLevel] = useState(0);
  useEffect(() => {
    setHintLevel(0);
  }, [currentHintsEntryIndex]);

  // Every 💡 click advances one level (see TipsPanel) — logged as the
  // "hintLevelUsed" metric the client asked to have recorded, since
  // there's no analytics backend to send it to yet.
  function handleHintReveal() {
    setHintLevel((prev) => {
      const next = Math.min(prev + 1, currentHints?.length ?? 3);
      console.log("[hint] nível usado:", next);
      return next;
    });
  }

  const isMobile = useIsMobile();

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
    const unsubError = orchestrator.onError((message) => {
      console.error("[conversation]", message);
      setToastMessage(message);
      if (toastTimeoutRef.current !== null) clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = setTimeout(() => setToastMessage(null), ERROR_TOAST_DURATION_MS);
    });
    const unsubApiStatus = orchestrator.onApiStatus(setConnected);
    const unsubTranscribing = orchestrator.onTranscribing((value) => {
      setTranscribing(value);
      avatarEngine.setTranscribing(value); // see AvatarEngine.getVideoState's transcribing override
    });
    const unsubAmplitude = orchestrator.onAmplitude(setMicAmplitude);
    const unsubAwaitingRepeat = orchestrator.onAwaitingRepeat(() => {
      setAwaitingRepeat(true);
      if (awaitingRepeatTimeoutRef.current !== null) clearTimeout(awaitingRepeatTimeoutRef.current);
      awaitingRepeatTimeoutRef.current = setTimeout(() => setAwaitingRepeat(false), 3000);
    });

    return () => {
      unsubEntries();
      unsubState();
      unsubError();
      unsubApiStatus();
      unsubTranscribing();
      unsubAmplitude();
      unsubAwaitingRepeat();
      if (toastTimeoutRef.current !== null) clearTimeout(toastTimeoutRef.current);
      if (awaitingRepeatTimeoutRef.current !== null) clearTimeout(awaitingRepeatTimeoutRef.current);
    };
  }, [orchestrator, avatarEngine]);

  // Clears early the moment the student actually acts (or the tutor moves
  // on) rather than always riding out the full 3s — e.g. clicking Falar
  // itself already makes the pulse redundant.
  useEffect(() => {
    if (characterState !== "idle") setAwaitingRepeat(false);
  }, [characterState]);

  // Resets the sound-wave bars to flat the instant listening stops — the
  // WhisperSTTProvider VAD interval that was driving micAmplitude is
  // already torn down by then, so without this the bars would otherwise
  // freeze at whatever RMS the last sample happened to be.
  useEffect(() => {
    if (characterState !== "listening") setMicAmplitude(0);
  }, [characterState]);

  async function handleStudentPick(student: DemoStudent) {
    // The demo-login buttons are already mounted during "fading" (for the
    // crossfade — see the app-shell render below), so a very fast click
    // could otherwise land before the loading screen has actually
    // finished fading out. Bailing out here guarantees the tutor's
    // kickoff (PRE_KICKOFF_DELAY_MS below) only ever starts counting once
    // bootState is truly "ready", not just "fading".
    if (bootState !== "ready") return;
    // Unlocks speechSynthesis on browsers (notably iOS Safari) that require
    // the first utterance to originate from a user gesture — this click is
    // the first real user gesture in the whole flow.
    if ("speechSynthesis" in window) {
      const warmUp = new SpeechSynthesisUtterance(" ");
      warmUp.volume = 0;
      window.speechSynthesis.speak(warmUp);
    }
    // iOS Safari requires a user gesture to resume an AudioContext and to
    // play audio/video with sound — this click is that gesture. MUST run
    // synchronously here, before the PRE_KICKOFF_DELAY_MS await below: one
    // microtask tick later and iOS no longer considers it gesture-
    // triggered, and the tutor's opening line (which plays after that
    // await, inside orchestrator.startLesson) would silently fail to play.
    // Also nudges the 5 avatar <video> elements — muted autoplay is
    // already exempt from this policy so they should be playing on their
    // own, but a stalled one (e.g. still mid-preload) costs nothing to
    // nudge here too.
    if (isIOS()) {
      unlockAudioForIOS();
      document.querySelectorAll<HTMLVideoElement>(".avatar-sprite-layer").forEach((video) => {
        void video.play().catch((err) => debugLog(`gesture play() falhou (${video.src}): ${describeError(err)}`));
      });
    }
    const lesson = getLessonByCode(student.currentLesson);
    const seconds = (lesson?.durationMinutes ?? DEFAULT_LESSON_DURATION_MIN) * 60;
    setStarted(true);
    setCurrentLesson(lesson);
    setTotalSeconds(seconds);
    setRemainingSeconds(seconds);
    setLessonComplete(false);
    setShowTimeUpNotice(false);
    await new Promise((resolve) => window.setTimeout(resolve, PRE_KICKOFF_DELAY_MS));
    // Consume (and clear) the cache entry rather than just reading it: a
    // second visit to the same student later in this page session (e.g.
    // after "Encerrar" and picking them again) should go through a fresh
    // live call, not replay an increasingly stale prefetched greeting.
    const prefetched = greetingCacheRef.current.get(student.id) ?? undefined;
    greetingCacheRef.current.delete(student.id);
    await orchestrator.startLesson({
      studentName: student.name,
      currentLessonCode: student.currentLesson,
      canDoGoals: lesson?.canDo,
      prefetched,
    });
  }

  // The ONLY call site for orchestrator.startListening() in the whole app
  // — push-to-talk is a hard rule (see orchestrator.ts's comments): the
  // microphone opens on this explicit click and never on its own.
  async function handleTalkClick() {
    const isListening = characterState === "listening";
    if (isListening) {
      await orchestrator.stopListening(); // force-send early
    } else {
      // startListening() returns false when the click was a no-op (the
      // orchestrator is busy with something else) — see its doc comment.
      // A shake makes that "not yet" visible instead of the click just
      // silently doing nothing, which reads identically to a frozen app.
      const started = await orchestrator.startListening();
      if (!started) {
        // DIAGNOSTIC LOGGING (temporary — see the Falar-button-freeze
        // investigation): the exact state the click bounced off of.
        console.log("[mic] bloqueado, estado:", {
          busy: orchestrator.isBusy(),
          characterState,
          isListening,
        });
        setShakeTrigger((n) => n + 1);
      }
    }
  }

  // The single page-level Falar button's onClick (see .force-send-btn-dock
  // below) — on mobile, closes the drawer first ("fecha sozinha quando o
  // aluno clica em Falar"), same behavior the button always had when it
  // used to live inside MobileVoiceScreen itself.
  function handleGlobalTalkClick() {
    mobileVoiceScreenRef.current?.closeDrawer();
    void handleTalkClick();
  }

  // Long-press escape hatch (see ForceSendButton / orchestrator.forceReset's
  // doc comments) — a safety net the student can reach for themselves if
  // the Falar button ever does get stuck despite the timeouts throughout
  // the app that are supposed to prevent that in the first place.
  function handleForceReset() {
    orchestrator.forceReset();
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
        <LoadingScreen
          status={bootState === "error" || bootState === "timeout" ? bootState : "loading"}
          fadingOut={bootState === "fading"}
          progressPct={bootProgressPct}
          statusText={bootStatusText}
        />
      )}

      <ErrorToast message={toastMessage} />

      {/* Deliberately OUTSIDE every bootState-gated block below — a
          "timeout"/"error" boot is exactly when this diagnostic is
          needed most, so it must not disappear behind (or get replaced
          by) LoadingScreen's own retry UI. See components/DebugPanel.tsx. */}
      {debugEnabled && <DebugPanel />}

      {(bootState === "fading" || bootState === "ready") && (
        <div className={`app-shell${bootState === "fading" ? " app-fade-in" : ""}`}>
          {/* Mobile renders its own floating header over the full-screen
              avatar (see MobileVoiceScreen) — this bar would otherwise eat
              into the 100dvh the avatar is supposed to fill entirely. */}
          {!isMobile && (
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
          )}

          {isMobile ? (
            <MobileVoiceScreen
              ref={mobileVoiceScreenRef}
              avatarEngine={avatarEngine}
              started={started}
              demoStudents={DEMO_STUDENTS}
              onStudentPick={handleStudentPick}
              totalSeconds={totalSeconds}
              remainingSeconds={remainingSeconds}
              showTimeUpNotice={showTimeUpNotice}
              entries={entries}
              currentLesson={currentLesson}
              currentHints={currentHints}
              hintLevel={hintLevel}
              onHintReveal={handleHintReveal}
              tipsAttention={tipsAttention}
              onTipsBlinkEnd={() => setTipsAttention("expanded")}
              inputValue={inputValue}
              onInputChange={(e) => {
                setInputValue(e.target.value);
                resetTipsAttention();
              }}
              onSubmit={handleSubmit}
              lessonComplete={lessonComplete}
              onEndLesson={handleEndLesson}
            />
          ) : (
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

                {/* The Falar button itself is no longer here — see
                    .force-send-btn-dock below, a single page-level
                    instance shared with the mobile layout so it can float
                    above everything, not just this avatar frame. */}
                {started && (
                  <div className="avatar-ui">
                    <div className="avatar-state">{stateLabel}</div>
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
                    hints={currentHints}
                    hintLevel={hintLevel}
                    onHintReveal={handleHintReveal}
                    lesson={currentLesson}
                    attention={tipsAttention}
                    onBlinkEnd={() => setTipsAttention("expanded")}
                  />
                </div>

                {started && <LessonTimer totalSeconds={totalSeconds} remainingSeconds={remainingSeconds} />}
                {started && showTimeUpNotice && !lessonComplete && (
                  <div className="session-time-notice">{branding.copy.sessionTimeUpNotice}</div>
                )}

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
          )}
        </div>
      )}

      {/* Single page-level instance shared by both layouts — deliberately
          NOT nested inside .app-shell/.stage/.chat/.mobile-screen: several
          of those ancestors use backdrop-filter or transform, either of
          which would silently make this element's `position: fixed`
          anchor to THAT ancestor's box instead of the real viewport (see
          .force-send-btn-dock's own doc comment in globals.css for the
          shake-animation reason it's a wrapper, not a prop, on the button
          itself). Rendered here, as a direct child of <main> (which has
          neither), it stays truly fixed to the viewport bottom no matter
          which layout or scroll state is underneath it. */}
      {started && (
        <div className="force-send-btn-dock">
          <ForceSendButton
            label={branding.copy.forceSendButton}
            listeningLabel={branding.copy.forceSendWhileListening}
            isListening={characterState === "listening"}
            processing={transcribing}
            hidden={characterState === "speaking"}
            awaitingRepeat={awaitingRepeat}
            onClick={handleGlobalTalkClick}
            onLongPress={handleForceReset}
            amplitude={micAmplitude}
            shakeTrigger={shakeTrigger}
          />
        </div>
      )}
    </main>
  );
}
