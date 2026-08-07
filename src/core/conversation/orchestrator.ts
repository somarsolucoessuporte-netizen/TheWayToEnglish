import type { SpeechProvider } from "../speech/SpeechProvider";
import type { SpeechToTextProvider, SttResult } from "../stt/SpeechToTextProvider";
import type { AIProvider, Message } from "../ai/AIProvider";
import type { TutorResponse } from "../ai/TutorResponse";
import type { AvatarEngine } from "../avatar-engine/AvatarEngine";
import { playCorrectSound } from "../audio/playCorrectSound";
import { CharacterStateMachine, type CharacterState } from "../character-state-machine/stateMachine";

export interface ConversationOrchestratorOptions {
  speech: SpeechProvider;
  stt: SpeechToTextProvider;
  ai: AIProvider;
  avatar: AvatarEngine;
  stateMachine?: CharacterStateMachine;
  systemPrompt: string;
  sessionId?: string;
}

/** How many words of speech.english / speech.portuguese are currently
 * visible on a "tutor" entry — see updateReveal. Absent (undefined
 * `reveal` on the entry) means "show everything", which is what every
 * entry that isn't a normal live conversational reply uses (scripted
 * announcements, etc.) — the reveal machinery is opt-in per entry. */
export interface RevealState {
  englishWordsShown: number;
  portugueseWordsShown: number;
}

export type ChatEntry =
  | { role: "user"; text: string }
  | { role: "tutor"; response: TutorResponse; pending?: boolean; reveal?: RevealState };

type EntriesListener = (entries: ChatEntry[]) => void;
type ErrorListener = (message: string) => void;
type ApiStatusListener = (online: boolean) => void;
type TranscribingListener = (transcribing: boolean) => void;
type LessonCompleteListener = () => void;
type AmplitudeListener = (rms: number) => void;
type AwaitingRepeatListener = () => void;

/** Per-call timeout bounds for the pronunciation drill's own short
 * speak() calls — see speakDrillPart. Deliberately much shorter than
 * OpenAITTSProvider's general-purpose 15s fetch / 10s playback-start
 * timeouts, which are sized for a full reply, not "Africa" or "Now you
 * try.". Slow speech genuinely takes a little longer to fetch/synthesize
 * than normal speed, hence the gap between the two. */
const DRILL_SLOW_TIMEOUT_MS = 8000;
const DRILL_NORMAL_TIMEOUT_MS = 6000;

/** Escalating idle-silence reactions — see the idle clock fields below and
 * persona.ts's ACTIVE TUTOR section. 'answer' is the 40s-total resolution
 * (give the answer, move on), not a 4th "estímulo" — see fireNudge's doc
 * comment for how it resets the cycle for whatever comes next. */
export type NudgeLevel = "gentle" | "help" | "offer" | "answer";

/** Cumulative idle-ms thresholds at which each nudge level fires, in
 * order — see startIdleClock/checkNudgeThresholds. Matches the client
 * spec's 6s/14s/25s/(25+15=40)s escalation exactly. */
const NUDGE_THRESHOLDS_MS: { level: NudgeLevel; ms: number }[] = [
  { level: "gentle", ms: 6000 },
  { level: "help", ms: 14000 },
  { level: "offer", ms: 25000 },
  { level: "answer", ms: 40000 },
];

/** Sent as the "user" turn once, right after the demo-student picker —
 * exported so page.tsx's boot-time greeting prefetch (see runBoot) can
 * send the byte-identical instruction and get back the exact same kind of
 * response startLesson would, instead of the two drifting independently. */
export const LESSON_KICKOFF_INSTRUCTION =
  "(Lesson start — do not repeat or quote this instruction back to the student.)";

/**
 * The only module that knows about STT, AI, TTS and the state machine at
 * the same time — UI components talk to this, never to the providers
 * directly (see spec section 6).
 */
export class ConversationOrchestrator {
  private readonly speech: SpeechProvider;
  private readonly stt: SpeechToTextProvider;
  private readonly ai: AIProvider;
  private readonly avatar: AvatarEngine;
  private readonly stateMachine: CharacterStateMachine;
  private readonly systemPrompt: string;
  private readonly sessionId: string;

  private history: Message[] = [];
  private entries: ChatEntry[] = [];
  private busy = false;

  /**
   * DIAGNOSTIC LOGGING (temporary — see the Falar-button-freeze
   * investigation): every write to `busy` goes through here instead of a
   * bare assignment, so the console shows exactly when it flips and which
   * call site did it. stack[2] (not [1]) is the actual caller — [0] is the
   * literal "Error" line, [1] is this method's own frame. Every existing
   * `this.busy = X` call site below has been changed to `this.setBusy(X)`
   * — no other behavior change.
   */
  private setBusy(value: boolean): void {
    this.busy = value;
    console.log(`[orchestrator] busy → ${value}`, new Error().stack?.split("\n")[2]?.trim());
  }

  private studentName: string | undefined;
  private currentLessonCode: string | undefined;
  /** Guards against overlapping start() calls — e.g. a double-click on the
   * talk button while getUserMedia is still resolving from the first one.
   * The mic is push-to-talk ONLY: startListening() is called from exactly
   * one place outside this file — the Falar button's onClick in page.tsx.
   * Nothing in this class ever calls it on its own; the microphone must
   * never open without that explicit click. */
  private listeningStartInFlight = false;
  /** Set once by announceTimeWarning() and carried on every subsequent
   * ai.send() call for the rest of the session — see AIOptions.timeWarning. */
  private timeWarningActive = false;
  /** The correction target (TutorResponse.correction.corrected, normalized)
   * the student is currently being drilled on, and how many consecutive
   * turns before the CURRENT one have already failed it — see
   * AIOptions.attemptCount and persona.ts's ATTEMPT-BASED CORRECTION
   * ESCALATION. Both reset to undefined/0 the moment a turn comes back
   * with no correction (success, or the conversation moved on) or with a
   * DIFFERENT correction target (a fresh, unrelated mistake). */
  private pendingCorrectionWord: string | undefined;
  private correctionAttemptCount = 0;

  /** The current lesson's can-do goals (verbatim, from CurriculumLesson.canDo
   * — see startLesson) and which of them the AI has confirmed the student
   * demonstrated so far (see TutorResponse.completedGoals / persona.ts's
   * LESSON COMPLETION section). The lesson is complete once every goal is
   * in here — NOT when the session timer runs out (see page.tsx's
   * LessonTimer, which is a visual reference only). `lessonCompleteFired`
   * guards against calling the completion listeners more than once. */
  private lessonGoals: string[] = [];
  private readonly completedGoals = new Set<string>();
  private lessonCompleteFired = false;

  /** Cumulative time spent in "idle" (mic closed, waiting on the student)
   * since the current question was posed — ticks up only while idle,
   * PAUSES (not resets) while a nudge itself is being spoken, and is
   * reset to 0 only by a real student interaction (handleUserMessage) or
   * by the 'answer' nudge (which represents moving on to a new question —
   * see fireNudge). This is what lets the 6s/14s/25s/40s thresholds below
   * be measured from "the question was asked", not "the last nudge fired". */
  private idleAccumulatedMs = 0;
  private idleTickHandle: ReturnType<typeof setInterval> | null = null;
  private readonly IDLE_TICK_MS = 500;
  /** Which nudge levels have already fired for the CURRENT question — see
   * idleAccumulatedMs's doc comment for what resets it. */
  private readonly nudgeLevelsFired = new Set<NudgeLevel>();
  /** Every nudge line actually spoken this session (verbatim), across all
   * questions — passed to /api/chat as AIOptions.usedNudges so the model
   * never repeats the same encouragement twice (see persona.ts's ACTIVE
   * TUTOR section). Deliberately NOT reset per-question, only by reset(). */
  private readonly usedNudgePhrases: string[] = [];

  private readonly entryListeners = new Set<EntriesListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly apiStatusListeners = new Set<ApiStatusListener>();
  private readonly transcribingListeners = new Set<TranscribingListener>();
  private readonly lessonCompleteListeners = new Set<LessonCompleteListener>();
  private readonly amplitudeListeners = new Set<AmplitudeListener>();
  private readonly awaitingRepeatListeners = new Set<AwaitingRepeatListener>();

  constructor(opts: ConversationOrchestratorOptions) {
    this.speech = opts.speech;
    this.stt = opts.stt;
    this.ai = opts.ai;
    this.avatar = opts.avatar;
    this.stateMachine = opts.stateMachine ?? new CharacterStateMachine();
    this.systemPrompt = opts.systemPrompt;
    this.sessionId = opts.sessionId ?? Math.random().toString(36).slice(2);

    // Instrumentation: every CharacterState transition, timestamped —
    // exactly the "[hh:mm:ss.mmm] idle -> listening" trail a freeze
    // investigation needs to see where things actually stopped, instead
    // of guessing from user reports alone.
    this.stateMachine.subscribe((state, prev) => {
      console.log(`[state] ${new Date().toISOString().slice(11, 23)} ${prev} -> ${state}`);
    });

    this.stateMachine.subscribe((state) => {
      this.avatar.setState(state);
      // The avatar visually stays "listening" through a batch STT
      // provider's upload/transcription gap (see "transcribing" below) —
      // but the moment the state machine actually leaves "listening" for
      // any reason, that gap is over one way or another.
      if (state !== "listening") this.setTranscribing(false);
      // Active-tutor idle nudges (see NUDGE_THRESHOLDS_MS): the clock only
      // ever runs while genuinely idle — never during listening, thinking,
      // speaking, or the praise/correction transients.
      if (state === "idle") this.startIdleClock();
      else this.stopIdleClock();
    });

    // Dispatches SPEECH_START on the provider's real "playing" DOM event
    // (see OpenAITTSProvider) — i.e. audio the student can actually hear,
    // not the moment speak() was called or the /api/tts fetch kicked off.
    // This is what the Avatar component's video play/pause is ultimately
    // driven by (via avatar.setState — see the stateMachine.subscribe
    // hook above): the video must never start before real audio does.
    //
    // A reply's speech can be spoken as multiple sequential speak() calls
    // (English part, then Portuguese part, or a correction's pronunciation
    // drill — see speakParts), and EACH call fires its own provider-level
    // "start". Dispatching SPEECH_START here on every one of them is safe,
    // not repeated-flicker: CharacterStateMachine only defines a
    // SPEECH_START transition FROM "thinking" — by the second part the
    // state machine is already "speaking", so the same dispatch is a
    // silent no-op, and the avatar's video keeps looping uninterrupted
    // instead of restarting between parts. speakParts is still the sole
    // authority for SPEECH_END, dispatched once after every part (and any
    // drill) is done, not per-call — that's what lets the video play
    // through an entire multi-part turn and stop only at its true end.
    this.speech.on("start", () => {
      this.stateMachine.dispatch({ type: "SPEECH_START" });
      // Lets Avatar.tsx size the speaking clip's manual loop count for
      // THIS specific segment — see AvatarEngine.setSpeechAudioDuration's
      // doc comment for why this fires once per part, not once per turn.
      this.avatar.setSpeechAudioDuration(this.speech.getAudioElement?.()?.duration ?? null);
    });
    // Fires once per individual speak() call's real end (or failure) — see
    // AvatarEngine.notifySpeechSegmentEnded's doc comment for why this is
    // NOT the same thing as the whole turn's SPEECH_END.
    this.speech.on("end", () => this.avatar.notifySpeechSegmentEnded());
    this.speech.on("error", () => this.avatar.notifySpeechSegmentEnded());

    // The transcript is delivered here, not through stop()'s return value —
    // continuous:false engines (the default BrowserSTTProvider) stop
    // themselves on silence, firing this with no explicit stop() call ever
    // having happened. See SpeechToTextProvider's "final" doc comment.
    this.stt.on("final", (payload) => {
      const { transcript, detectedLanguage } = (payload as SttResult) ?? { transcript: "" };
      const text = transcript.trim();
      if (this.stateMachine.getState() !== "listening") return;
      this.stateMachine.dispatch({ type: "STOP_LISTENING" });
      if (text) {
        void this.handleUserMessage(text, detectedLanguage);
      } else {
        this.stateMachine.dispatch({ type: "RESET" });
      }
    });
    // "end" without a preceding "final" means listening stopped with
    // nothing said (silence, timeout) — just go back to idle.
    this.stt.on("end", () => {
      if (this.stateMachine.getState() === "listening") {
        this.stateMachine.dispatch({ type: "RESET" });
      }
    });
    this.stt.on("error", (err) => {
      this.emitError(`STT: ${String(err)}`);
      this.stateMachine.dispatch({ type: "ERROR" });
    });
    // Only fires for STT providers with an upload/processing gap between
    // "stopped recording" and "transcript ready" (e.g. WhisperSTTProvider).
    // BrowserSTTProvider never emits this — it transcribes live.
    this.stt.on("transcribing", () => this.setTranscribing(true));
    // Real-time mic RMS from a provider with an energy-based VAD (see
    // WhisperSTTProvider) — forwarded as-is for the UI's sound-wave
    // indicator (see ForceSendButton). Never fires for a provider without
    // one, same as "transcribing".
    this.stt.on("amplitude", (rms) => {
      for (const cb of this.amplitudeListeners) cb(rms as number);
    });
  }

  onEntriesChange(cb: EntriesListener): () => void {
    this.entryListeners.add(cb);
    return () => this.entryListeners.delete(cb);
  }

  onError(cb: ErrorListener): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  /** Reflects real /api/chat call outcomes — there's no WebSocket/session
   * to be "connected" to, just fetch requests that either succeed or don't. */
  onApiStatus(cb: ApiStatusListener): () => void {
    this.apiStatusListeners.add(cb);
    return () => this.apiStatusListeners.delete(cb);
  }

  onStateChange(cb: (state: CharacterState) => void): () => void {
    return this.stateMachine.subscribe((state) => cb(state));
  }

  /** True while a batch STT provider is uploading/transcribing after the
   * student stopped talking but before a transcript has come back. The
   * character state stays "listening" throughout — this is purely for a
   * UI label ("Transcrevendo…") so the wait doesn't look like a freeze. */
  onTranscribing(cb: TranscribingListener): () => void {
    this.transcribingListeners.add(cb);
    return () => this.transcribingListeners.delete(cb);
  }

  /** Real-time mic RMS while listening (see stt.on("amplitude") in the
   * constructor) — drives the Falar button's sound-wave indicator with
   * actual voice amplitude instead of a canned animation. Never fires for
   * an STT provider without a real VAD (e.g. BrowserSTTProvider). */
  onAmplitude(cb: AmplitudeListener): () => void {
    this.amplitudeListeners.add(cb);
    return () => this.amplitudeListeners.delete(cb);
  }

  /** Fires the instant the "hear it, repeat it" drill's "Now you try."
   * cue (see runPronunciationDrill) finishes playing — the Falar button's
   * UI pulses its border for a few seconds afterward so the student
   * notices it's their turn to attempt the word, instead of the cue
   * landing on a button that looks identical to every other idle moment. */
  onAwaitingRepeat(cb: AwaitingRepeatListener): () => void {
    this.awaitingRepeatListeners.add(cb);
    return () => this.awaitingRepeatListeners.delete(cb);
  }

  /** Fires exactly once per lesson, the moment every can-do goal has been
   * demonstrated (see updateGoalProgress) — independent of the session
   * timer. page.tsx uses this (not the timer hitting 0) to show the
   * completion card. */
  onLessonComplete(cb: LessonCompleteListener): () => void {
    this.lessonCompleteListeners.add(cb);
    return () => this.lessonCompleteListeners.delete(cb);
  }

  getState(): CharacterState {
    return this.stateMachine.getState();
  }

  isBusy(): boolean {
    return this.busy;
  }

  /**
   * Returns false when the click was a no-op (the orchestrator is busy
   * doing something else, or a start() call is already in flight) instead
   * of just silently doing nothing — page.tsx uses this to give the
   * student a visible "not yet" signal (a brief shake on the button)
   * rather than a click that appears to do absolutely nothing, which is
   * indistinguishable from a genuinely frozen app.
   */
  async startListening(): Promise<boolean> {
    if (this.busy || this.listeningStartInFlight) {
      console.log(
        `[state] click ignorado — busy=${this.busy} listeningStartInFlight=${this.listeningStartInFlight}`
      );
      return false;
    }
    if (this.stateMachine.getState() === "listening") return true; // already listening, nothing to do
    this.listeningStartInFlight = true;
    this.setTranscribing(false);
    try {
      await this.stt.start();
      this.stateMachine.dispatch({ type: "START_LISTENING" });
    } catch (err) {
      this.emitError(errorMessage(err));
      this.stateMachine.dispatch({ type: "ERROR" });
    } finally {
      this.listeningStartInFlight = false;
    }
    return true;
  }

  /**
   * Manual force-send: the student clicked the talk button again while
   * already listening, ending the recording right now instead of waiting
   * for the STT provider's own silence-based auto-stop (see
   * WhisperSTTProvider's VAD) to notice the pause. Push-to-talk's second
   * half — click opens the mic (startListening, called only from the
   * button's onClick), click-again-or-silence closes it (this, or the
   * provider's own VAD). The actual state transition and message handling
   * happen in the "final"/"end" listeners wired in the constructor — not
   * here — because the provider's VAD may have already finished the
   * utterance on its own before this is even called.
   */
  async stopListening(): Promise<void> {
    await this.stt.stop();
  }

  async sendTextMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.busy) return;
    this.stateMachine.dispatch({ type: "STOP_LISTENING" }); // idle -> thinking
    await this.handleUserMessage(trimmed);
  }

  /**
   * Called once, right after the demo-student picker: stores the student's
   * name and current lesson code for the rest of the session, and kicks
   * off the lesson with the tutor's active opening line — without a fake
   * "user" bubble in the chat log (see the `silent` option below). The
   * actual lesson content is resolved server-side from the code (see
   * app/api/chat/route.ts + app-config/curriculum) — the persona's
   * "YOU LEAD THE SESSION" instruction does the rest.
   *
   * `prefetched`, if given, is a {response, audioBlob} pair for this exact
   * student+lesson already fetched during the boot loading screen (see
   * page.tsx's runBoot) — when present, this skips both the /api/chat call
   * AND the /api/tts fetch entirely and speaks instantly from the cached
   * blob, instead of paying for either round trip after the student has
   * already clicked and is waiting. Falls back to the normal live call
   * transparently if there's no prefetch (cache miss, or it hasn't
   * resolved yet) — see runTurn's prefetchedResponse param.
   */
  async startLesson(opts: {
    studentName: string;
    currentLessonCode: string;
    canDoGoals?: string[];
    /** See CurriculumLesson.vocabulary / SpeechToTextProvider.setLessonVocabulary
     * — forwarded straight to the STT provider so it can hint transcription
     * toward this lesson's specific words (Whisper's `prompt`, see
     * /api/stt/route.ts). */
    vocabulary?: string[];
    prefetched?: { response: TutorResponse; audioBlob?: Blob };
  }): Promise<void> {
    this.studentName = opts.studentName;
    this.currentLessonCode = opts.currentLessonCode;
    this.lessonGoals = opts.canDoGoals ?? [];
    this.stt.setLessonVocabulary?.(opts.vocabulary ?? []);
    this.completedGoals.clear();
    this.lessonCompleteFired = false;
    this.idleAccumulatedMs = 0;
    this.nudgeLevelsFired.clear();
    this.stateMachine.dispatch({ type: "STOP_LISTENING" }); // idle -> thinking
    this.history.push({ role: "user", content: LESSON_KICKOFF_INSTRUCTION });
    await this.runTurn({ prefetchedResponse: opts.prefetched?.response, prefetchedAudioBlob: opts.prefetched?.audioBlob });
    // runTurn ends back on "idle" once the tutor's opening line finishes
    // speaking. The mic stays closed until the student clicks Falar — no
    // auto-listen here or anywhere else in this class.
  }

  /**
   * Scripted (non-AI) interruption fired once by the lesson timer (see
   * LessonTimer / page.tsx) when ~3 minutes remain. Speaks a fixed English
   * heads-up, logs it as a tutor chat entry, and — from this point on —
   * flags every subsequent ai.send() call with timeWarning: true so the
   * persona actively wraps the lesson up (see persona.ts's TIME MANAGEMENT
   * section) instead of starting new ground. Safe to call more than once;
   * only the first call actually does anything.
   */
  async announceTimeWarning(): Promise<void> {
    if (this.timeWarningActive) return;
    this.timeWarningActive = true;
    const response: TutorResponse = {
      speech: { english: "We have about 3 minutes left. Let's wrap up!", portuguese: "" },
    };
    this.pushEntry({ role: "tutor", response });
    await this.forceAnnounce([{ text: response.speech.english, lang: "en-US" }]);
    // Mic stays closed after this, same as after any other tutor turn —
    // the student clicks Falar when they're ready to answer.
  }

  /**
   * Scripted (non-AI) closing beat fired once by page.tsx's
   * onLessonComplete subscription, the moment every can-do goal for the
   * lesson has been demonstrated (see updateGoalProgress) — NOT by the
   * session timer running out, which is a visual reference only (see
   * LessonTimer). Puts the avatar in "praise" and speaks the fixed closing
   * lines — the completion card (see page.tsx) takes over from here, not
   * another turn of conversation.
   */
  async announceLessonComplete(): Promise<void> {
    const response: TutorResponse = {
      speech: {
        english: "Great job today!",
        portuguese: "Você completou a lição de hoje! Até a próxima.",
      },
      praise: true,
    };
    this.pushEntry({ role: "tutor", response });
    await this.forceAnnounce(
      [
        { text: response.speech.english, lang: "en-US" },
        { text: response.speech.portuguese, lang: "pt-BR" },
      ],
      { praiseFirst: true }
    );
  }

  /**
   * Cuts into whatever's currently happening (an open recording, mid-think,
   * mid-speech) and forces a clean path to "speaking" for a scripted
   * announcement that isn't a reply to anything the student said. RESET
   * works from any state, so this is the one dispatch sequence guaranteed
   * to succeed regardless of what the state machine was doing a moment
   * ago. Guarded by `busy` for the same reason handleUserMessage is: stops
   * a stray STT "final" event or a manual button click from landing mid-
   * announcement.
   */
  private async forceAnnounce(
    parts: { text: string; lang: string }[],
    opts: { praiseFirst?: boolean } = {}
  ): Promise<void> {
    this.setBusy(true);
    try {
      if (this.stateMachine.getState() === "listening") {
        await this.stt.stop().catch(() => {});
      }
      this.stateMachine.dispatch({ type: "RESET" }); // -> idle, from any state
      this.stateMachine.dispatch({ type: "STOP_LISTENING" }); // idle -> thinking
      if (opts.praiseFirst) await this.enterPraiseBeforeSpeaking();
      await this.speakParts(parts);
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * Clears all session state back to fresh — called when the student clicks
   * "Encerrar" on the lesson-complete card to return to the onboarding
   * screen. Without this, picking a new demo student would carry over the
   * previous lesson's chat history and entries into the new session.
   */
  reset(): void {
    this.speech.cancel();
    this.stopIdleClock();
    this.history = [];
    this.entries = [];
    for (const cb of this.entryListeners) cb(this.entries);
    this.setBusy(false);
    this.studentName = undefined;
    this.currentLessonCode = undefined;
    this.timeWarningActive = false;
    this.pendingCorrectionWord = undefined;
    this.correctionAttemptCount = 0;
    this.lessonGoals = [];
    this.stt.setLessonVocabulary?.([]);
    this.completedGoals.clear();
    this.lessonCompleteFired = false;
    this.idleAccumulatedMs = 0;
    this.nudgeLevelsFired.clear();
    this.usedNudgePhrases.length = 0;
    this.stateMachine.dispatch({ type: "RESET" });
  }

  /**
   * Safety-net escape hatch for the Falar button's long-press gesture (see
   * ForceSendButton/page.tsx) — deliberately much lighter than reset():
   * it does NOT touch the conversation history, lesson, or entries, only
   * whatever's currently in flight. The premise is "something hung" (a
   * dead network request, a stuck getUserMedia prompt, an audio element
   * that stopped firing events) — the network/audio-layer timeouts added
   * throughout this app should make forceReset() rarely needed in
   * practice, but it exists as the guaranteed-to-work fallback for
   * whatever those timeouts didn't anticipate. Safe to call from any
   * state, any time, including while nothing is actually stuck.
   */
  forceReset(): void {
    console.log("[state] forceReset() — escape hatch acionado");
    this.speech.cancel();
    // Prefer the provider's own abort() (see SpeechToTextProvider.abort's
    // doc comment) — it can tear down an in-flight getUserMedia/upload
    // that a plain stop() call wouldn't necessarily unstick. Fall back to
    // stop() for a provider that doesn't implement it.
    if (this.stt.abort) this.stt.abort();
    else void this.stt.stop().catch(() => {});
    this.setBusy(false);
    this.listeningStartInFlight = false;
    this.setTranscribing(false);
    this.stateMachine.dispatch({ type: "RESET" });
    this.emitError("Reiniciado — pode tentar novamente.");
  }

  /**
   * Immediately silences any in-flight TTS audio and closes the mic,
   * without touching conversation state (history, entries, busy, lesson
   * progress) — unlike reset()/forceReset(), which are for "start fresh"
   * or "something hung" situations where clearing that state is the
   * point. This is for the one moment where none of that state matters
   * because the JS context is about to be torn down anyway: a page
   * reload/navigation-away (see page.tsx's beforeunload/pagehide
   * listener) or this component unmounting. Without it, OpenAITTSProvider's
   * `Audio` objects (never attached to the DOM, so a naive
   * `document.querySelectorAll('audio')` sweep wouldn't even find them —
   * see cancel()) and WhisperSTTProvider's open `MediaStream`/AudioContext
   * would otherwise keep running for whatever few hundred ms the browser
   * takes to actually unload the page, which is what let the tutor's
   * question keep audibly playing through a reload.
   */
  stopAllMedia(): void {
    this.speech.cancel();
    if (this.stt.abort) this.stt.abort();
    else void this.stt.stop().catch(() => {});
    this.stopIdleClock();
  }

  /**
   * Updates the consecutive-attempt tracking used for AIOptions.attemptCount
   * (see the fields' doc comments) from the response that just arrived —
   * called right after every ai.send(), so the count sent on the NEXT call
   * reflects everything up to and including this turn. Same target word
   * (case/whitespace-insensitive) as last time -> increment; a different
   * target, or no correction at all -> reset (fresh mistake, or the
   * student moved past it).
   */
  private updateCorrectionAttemptTracking(response: TutorResponse): void {
    if (!response.correction) {
      this.pendingCorrectionWord = undefined;
      this.correctionAttemptCount = 0;
      return;
    }
    const word = response.correction.corrected.trim().toLowerCase();
    if (word && word === this.pendingCorrectionWord) {
      this.correctionAttemptCount += 1;
    } else {
      this.pendingCorrectionWord = word;
      this.correctionAttemptCount = 1;
    }
  }

  /** Merges response.completedGoals (see TutorResponse / persona.ts's
   * LESSON COMPLETION) into the running set, and fires onLessonComplete
   * exactly once the moment every goal for the current lesson is in —
   * called right after every ai.send(), same as
   * updateCorrectionAttemptTracking. Unknown goal strings (a model typo, a
   * goal that isn't verbatim in lessonGoals) are dropped silently rather
   * than counted — better to under-complete than to finish a lesson on a
   * goal that was never actually assigned. */
  private updateGoalProgress(response: TutorResponse): void {
    if (this.lessonCompleteFired || this.lessonGoals.length === 0) return;
    for (const goal of response.completedGoals ?? []) {
      if (this.lessonGoals.includes(goal)) this.completedGoals.add(goal);
    }
    if (this.completedGoals.size >= this.lessonGoals.length) {
      this.lessonCompleteFired = true;
      for (const cb of this.lessonCompleteListeners) cb();
    }
  }

  private async handleUserMessage(text: string, detectedLanguage?: string): Promise<void> {
    this.pushEntry({ role: "user", text });
    this.history.push({ role: "user", content: text });
    // A real student turn always supersedes whatever nudge escalation was
    // in progress for the previous question — see idleAccumulatedMs's doc
    // comment. The idle clock is already stopped by now (STOP_LISTENING
    // was dispatched, synchronously, by every caller before this runs).
    this.idleAccumulatedMs = 0;
    this.nudgeLevelsFired.clear();
    await this.runTurn({ detectedLanguage });
  }

  /**
   * Fires one escalating idle-silence reaction (see NUDGE_THRESHOLDS_MS
   * and persona.ts's ACTIVE TUTOR section) — called only from
   * checkNudgeThresholds, never directly. Sends a `nudge` marker instead
   * of a fake student message (see AIOptions.nudge): the model sees the
   * SAME conversation it already had, plus a system note that the student
   * has gone quiet, and reacts as itself — not as if the student said
   * something. 'answer' additionally resets the idle clock once it's
   * done, since giving the answer and moving on is exactly what turns
   * this into a fresh question with its own idle budget.
   */
  private async fireNudge(level: NudgeLevel): Promise<void> {
    if (this.busy) return; // idle clock only runs while genuinely idle; defensive only
    this.stateMachine.dispatch({ type: "STOP_LISTENING" }); // idle -> thinking
    await this.runTurn({ nudge: level });
    if (level === "answer") {
      this.idleAccumulatedMs = 0;
      this.nudgeLevelsFired.clear();
    }
  }

  /** Ticks idleAccumulatedMs while (and only while) the character state is
   * "idle" — started/stopped from the constructor's stateMachine.subscribe
   * hook. Restarting on every idle entry (rather than one persistent
   * interval) keeps this trivially correct: there is never a tick in
   * flight while any non-idle state is active. */
  private startIdleClock(): void {
    this.stopIdleClock();
    this.idleTickHandle = setInterval(() => {
      this.idleAccumulatedMs += this.IDLE_TICK_MS;
      void this.checkNudgeThresholds();
    }, this.IDLE_TICK_MS);
  }

  private stopIdleClock(): void {
    if (this.idleTickHandle !== null) {
      clearInterval(this.idleTickHandle);
      this.idleTickHandle = null;
    }
  }

  /** Fires at most one nudge level per tick, highest threshold crossed
   * first — checking from the top down means a single slow tick (e.g. the
   * tab was backgrounded) that jumps straight past an earlier threshold
   * doesn't fire two nudges back to back, just the furthest one reached. */
  private async checkNudgeThresholds(): Promise<void> {
    const ms = this.idleAccumulatedMs;
    for (let i = NUDGE_THRESHOLDS_MS.length - 1; i >= 0; i--) {
      const { level, ms: threshold } = NUDGE_THRESHOLDS_MS[i];
      if (ms >= threshold && !this.nudgeLevelsFired.has(level)) {
        this.nudgeLevelsFired.add(level);
        await this.fireNudge(level);
        return;
      }
    }
  }

  /**
   * Shared "ask the AI, display, and speak the reply" turn — used both by
   * real student messages (handleUserMessage) and by idle nudges
   * (fireNudge), which differ only in what accompanies the request:
   * nothing new was said, vs. an internal nudge marker (see AIOptions).
   *
   * `prefetchedResponse`/`prefetchedAudioBlob` (startLesson only) skip the
   * /api/chat call and/or the first part's /api/tts fetch respectively
   * when a boot-time greeting prefetch (see page.tsx's runBoot) already
   * has them ready — see speakOnePartWithReveal for how the blob is used.
   */
  private async runTurn(opts: {
    detectedLanguage?: string;
    nudge?: NudgeLevel;
    prefetchedResponse?: TutorResponse;
    prefetchedAudioBlob?: Blob;
  } = {}): Promise<void> {
    this.setBusy(true);
    // Hoisted out of the try block so the catch below can still find and
    // resolve THIS turn's pending chat bubble (see pushPendingTutorEntry)
    // if something throws after it was created but before speakPartsWithReveal
    // ever gets to clear it — e.g. playCorrectSound() throwing on the praise
    // beat (a fresh AudioContext can throw once a browser's per-page limit is
    // hit — Safari/iOS is known to cap this). Without this, busy still
    // correctly clears (see the outer finally), but the chat bubble itself
    // stays stuck on its "..." typing indicator forever, which is what
    // actually reads as a freeze to the student.
    let entryIndex: number | undefined;
    try {
      let response: TutorResponse;
      // Marks "the reply is ready to be spoken" — for a live call this is
      // the moment /api/chat responds; for a boot-time prefetch it's
      // effectively now, since there's nothing left to wait for. Passed
      // through to speakOnePartWithReveal so it can log the actual
      // requirement-(f) number: time from here to the audio's real "start".
      let readyAt: number;
      if (opts.prefetchedResponse) {
        response = opts.prefetchedResponse;
        readyAt = performance.now();
        console.log("[latency] usando saudação pré-carregada do splash — sem espera de /api/chat");
      } else {
        const messages: Message[] = [{ role: "system", content: this.systemPrompt }, ...this.history];
        const chatRequestStart = performance.now();
        response = await this.ai.send(messages, {
          sessionId: this.sessionId,
          detectedLanguage: opts.detectedLanguage,
          studentName: this.studentName,
          currentLessonCode: this.currentLessonCode,
          timeWarning: this.timeWarningActive,
          attemptCount: this.correctionAttemptCount,
          nudge: opts.nudge,
          usedNudges: this.usedNudgePhrases,
        });
        readyAt = performance.now();
        console.log(
          `[latency] /api/chat respondeu em ${Math.round(readyAt - chatRequestStart)}ms` +
            (opts.nudge ? ` (nudge: ${opts.nudge})` : "")
        );
      }
      this.setApiStatus(true);
      this.updateCorrectionAttemptTracking(response);
      this.updateGoalProgress(response);

      this.history.push({
        role: "assistant",
        content: [response.speech.english, response.speech.portuguese].filter((s) => s.trim()).join(" / "),
      });
      if (opts.nudge) {
        const spoken = [response.speech.english, response.speech.portuguese].filter((s) => s.trim()).join(" ");
        if (spoken) this.usedNudgePhrases.push(spoken);
      }

      entryIndex = this.pushPendingTutorEntry(response);

      // Praise plays out BEFORE speaking, not after: a short chord plus the
      // avatar's praise pose for ~1.5s, then normal speech resumes — the
      // "you got it right" beat should land the moment the answer's judged
      // correct, not as an afterthought once the tutor's already talking.
      if (response.praise) {
        playCorrectSound();
        await this.enterPraiseBeforeSpeaking();
      }

      // Normally English plays first, Portuguese second. A correction is the
      // one exception: the "hear it, repeat it" flow needs the Portuguese
      // explanation (ending in "Agora repita comigo:") to land right before
      // the English repeat-model it's cueing up — see persona.ts's
      // CORRECTING A MISTAKE sequence.
      const englishPart = { text: response.speech.english, lang: "en-US" };
      const portuguesePart = { text: response.speech.portuguese, lang: "pt-BR" };
      const correction = response.correction;
      await this.speakPartsWithReveal(
        correction ? [portuguesePart, englishPart] : [englishPart, portuguesePart],
        entryIndex,
        response,
        correction ? { after: () => this.runPronunciationDrill(correction.corrected) } : {},
        opts.prefetchedAudioBlob,
        readyAt
      );
      // speakPartsWithReveal has already brought the state machine back to
      // idle by the time it resolves — correction now overlays on top of
      // that idle state and reverts back to it on its own after ~1.5s.
      // Praise already happened above, before speaking.
      if (correction) this.stateMachine.dispatch({ type: "CORRECTION" });
    } catch (err) {
      this.setApiStatus(false);
      this.emitError(errorMessage(err));
      this.stateMachine.dispatch({ type: "ERROR" });
      // See entryIndex's doc comment above — without this, a pending
      // bubble whose turn blew up before ever reaching speakPartsWithReveal
      // (or partway through it) is left showing "..." forever, even though
      // the error toast and busy=false already correctly fired.
      if (entryIndex !== undefined) {
        const orphaned = this.entries[entryIndex];
        if (orphaned?.role === "tutor" && orphaned.pending) {
          this.replaceEntry(entryIndex, { role: "tutor", response: orphaned.response });
        }
      }
    } finally {
      this.setBusy(false);
    }
    // Mic stays closed once the tutor's done — push-to-talk only. The
    // student clicks Falar (see ForceSendButton's onClick in page.tsx)
    // when they're ready to answer; nothing here reopens it for them.
  }

  /** Appends a placeholder "tutor" entry with the real response data
   * attached but `pending: true` — the UI (see ChatLog) renders this as a
   * typing indicator instead of text, so nothing appears on screen until
   * speech actually starts (see speakOnePartWithReveal's "start" handler,
   * which is what first flips pending to false via updateReveal). */
  private pushPendingTutorEntry(response: TutorResponse): number {
    this.entries = [
      ...this.entries,
      { role: "tutor", response, pending: true, reveal: { englishWordsShown: 0, portugueseWordsShown: 0 } },
    ];
    for (const cb of this.entryListeners) cb(this.entries);
    return this.entries.length - 1;
  }

  private replaceEntry(index: number, entry: ChatEntry): void {
    if (index < 0 || index >= this.entries.length) return;
    this.entries = this.entries.map((e, i) => (i === index ? entry : e));
    for (const cb of this.entryListeners) cb(this.entries);
  }

  /** Merges a new word count for one language half of a tutor entry's
   * text into its reveal state, leaving the other half's progress alone —
   * called repeatedly (once per revealed word) by speakOnePartWithReveal's
   * "start" handler. Always clears `pending`, since the very first call
   * only ever happens once audio is genuinely playing. */
  private updateReveal(index: number, response: TutorResponse, isEnglish: boolean, wordsShown: number): void {
    const current = this.entries[index];
    if (!current || current.role !== "tutor") return;
    const prevReveal = current.reveal ?? { englishWordsShown: 0, portugueseWordsShown: 0 };
    const reveal: RevealState = isEnglish
      ? { ...prevReveal, englishWordsShown: wordsShown }
      : { ...prevReveal, portugueseWordsShown: wordsShown };
    this.replaceEntry(index, { role: "tutor", response, pending: false, reveal });
  }

  /**
   * Puts the avatar in the "praise" pose and waits for it to revert on its
   * own (CharacterStateMachine's transient timer, ~1.5s) before resolving —
   * that revert lands back on "thinking" (the persistent state captured
   * when PRAISE was dispatched, since a response always arrives while
   * still "thinking"), which is exactly the state the "start" event's
   * SPEECH_START dispatch (see constructor) needs to transition out of
   * once speakParts actually starts playing audio next.
   */
  private async enterPraiseBeforeSpeaking(): Promise<void> {
    return new Promise<void>((resolve) => {
      const unsubscribe = this.stateMachine.subscribe((state) => {
        if (state !== "praise") {
          unsubscribe();
          resolve();
        }
      });
      this.stateMachine.dispatch({ type: "PRAISE" });
    });
  }

  /**
   * Speaks one or more parts back-to-back as a single logical "speaking"
   * turn. Does NOT dispatch SPEECH_START itself — that happens the moment
   * the first part's audio is actually audible (see the constructor's
   * `speech.on("start", ...)` handler), so the state machine (and the
   * avatar's mouth animation) stays "thinking" through the whole
   * /api/tts fetch instead of jumping to "speaking" early. SPEECH_END,
   * though, IS this method's responsibility: dispatched once after the
   * last part (and after `opts.after`, if given) finishes, regardless of
   * how many actual speak() calls happened underneath — that's what lets
   * a bilingual reply (English part, then Portuguese part) or a
   * correction's pronunciation drill (see runPronunciationDrill) play as
   * one continuous "speaking" state instead of flickering back to idle
   * between parts.
   */
  private async speakParts(
    parts: { text: string; lang: string }[],
    opts: { after?: () => Promise<void> } = {}
  ): Promise<void> {
    const nonEmpty = parts.filter((p) => p.text.trim().length > 0);
    if (nonEmpty.length === 0 && !opts.after) {
      // No audio ever played, so there's no "start" event to drive the
      // usual SPEECH_START -> SPEECH_END path — RESET is the one
      // transition guaranteed to work from any state (see
      // CharacterStateMachine.dispatch), so the avatar doesn't get stuck
      // showing "thinking" forever with nothing left to wait on.
      this.stateMachine.dispatch({ type: "RESET" });
      return;
    }

    for (const part of nonEmpty) {
      await this.speech.speak(part.text, { lang: part.lang });
    }
    if (opts.after) await opts.after();
    this.stateMachine.dispatch({ type: "SPEECH_END" });
  }

  /**
   * Same job as speakParts, plus progressively revealing the chat entry at
   * `entryIndex` word by word as each part's audio actually plays — see
   * TEXT/VOICE SYNC in the class-level notes and speakOnePartWithReveal.
   * Used by runTurn for real conversational replies; forceAnnounce's fixed
   * scripted lines still go through the plain speakParts above (their text
   * is pushed in full up front, not worth the reveal machinery).
   */
  private async speakPartsWithReveal(
    parts: { text: string; lang: string }[],
    entryIndex: number,
    response: TutorResponse,
    opts: { after?: () => Promise<void> } = {},
    prefetchedAudioBlob?: Blob,
    readyAt?: number
  ): Promise<void> {
    const nonEmpty = parts.filter((p) => p.text.trim().length > 0);
    if (nonEmpty.length === 0 && !opts.after) {
      this.replaceEntry(entryIndex, { role: "tutor", response });
      // See speakParts's matching branch for why RESET (not SPEECH_END,
      // which is a no-op from "thinking" — see PERSISTENT_TRANSITIONS).
      this.stateMachine.dispatch({ type: "RESET" });
      return;
    }

    for (let i = 0; i < nonEmpty.length; i++) {
      // The prefetched blob (if any) only ever corresponds to the FIRST
      // part of a fresh greeting — see startLesson. Same for readyAt: only
      // the very first part's "start" is the number requirement (f) cares
      // about — the moment the student first hears anything at all.
      await this.speakOnePartWithReveal(
        nonEmpty[i],
        entryIndex,
        response,
        i === 0 ? prefetchedAudioBlob : undefined,
        i === 0 ? readyAt : undefined
      );
    }
    if (opts.after) await opts.after();
    // Final safety net: whatever the per-part reveal timers left showing,
    // the full text (and no more pending/typing state) must be visible
    // now that speaking is genuinely over.
    this.replaceEntry(entryIndex, { role: "tutor", response });
    this.stateMachine.dispatch({ type: "SPEECH_END" });
  }

  /**
   * Speaks a single part while revealing entryIndex's text for that
   * language, word by word, timed against the ACTUAL audio duration —
   * not a fixed guess. The moment the provider's "start" event fires
   * (audio genuinely audible — see OpenAITTSProvider), this reads the
   * real <audio> element's `duration` (available almost immediately,
   * since the provider fetches the whole MP3 before ever creating the
   * element — no streaming-duration uncertainty) and reveals one word
   * every `duration / wordCount`, exactly matching the spec's "não
   * precisa ser perfeito, só precisa parecer que ela está falando aquilo
   * naquele momento" — this doesn't need frame-accurate lip sync, just a
   * reveal that finishes roughly when the audio does. providers without a
   * real <audio> element (getAudioElement missing, e.g. WebSpeechProvider)
   * fall back to a flat per-word estimate instead of failing.
   *
   * The `finally` block is what makes requirement (d) — "full text visible
   * once the audio ends" — actually robust: whatever the interval's
   * progress was, this force-completes the reveal the instant speak()'s
   * promise resolves (which only happens on the provider's own "end"/
   * "error"), so a reveal that undershoots (slow ticks, a duration
   * estimate that ran long) never leaves trailing unrevealed words once
   * playback has genuinely stopped.
   */
  private async speakOnePartWithReveal(
    part: { text: string; lang: string },
    entryIndex: number,
    response: TutorResponse,
    prefetchedAudioBlob?: Blob,
    readyAt?: number
  ): Promise<void> {
    const words = part.text.trim().split(/\s+/).filter(Boolean);
    const isEnglish = part.lang.startsWith("en");

    let revealTimer: ReturnType<typeof setInterval> | null = null;
    const stopTimer = () => {
      if (revealTimer !== null) {
        clearInterval(revealTimer);
        revealTimer = null;
      }
    };

    const unsubscribeStart = this.speech.on("start", () => {
      unsubscribeStart(); // one-shot — only this part's own "start" matters here
      if (readyAt !== undefined) {
        // Requirement (f): real, measured time from /api/chat's response
        // to the audio actually being audible — not an estimate.
        console.log(`[latency] resposta pronta -> áudio 'start': ${Math.round(performance.now() - readyAt)}ms`);
      }
      const audio = this.speech.getAudioElement?.();
      const durationMs =
        audio && Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000
          : words.length * 280; // rough fallback for a provider with no real <audio> element
      const intervalMs = Math.max(60, durationMs / words.length);

      let shown = 0;
      const tick = () => {
        shown = Math.min(words.length, shown + 1);
        this.updateReveal(entryIndex, response, isEnglish, shown);
        if (shown >= words.length) stopTimer();
      };
      tick(); // first word appears the instant audio starts, not one interval later
      revealTimer = setInterval(tick, intervalMs);
    });

    try {
      if (prefetchedAudioBlob && this.speech.speakBlob) {
        await this.speech.speakBlob(prefetchedAudioBlob);
      } else {
        await this.speech.speak(part.text, { lang: part.lang });
      }
    } finally {
      unsubscribeStart(); // in case "start" never fired at all (e.g. an immediate error)
      stopTimer();
      this.updateReveal(entryIndex, response, isEnglish, words.length);
    }
  }

  /**
   * Speaks one pronunciation-drill part, bounded to `timeoutMs` —
   * independent of OpenAITTSProvider's own general-purpose 15s fetch /
   * 10s playback-start timeouts (sized for a full reply, wildly excessive
   * for a single short word — 3 of those back to back is where the
   * Falar-button-freeze investigation's ~75s worst case came from). NEVER
   * throws: a failed or slow part is logged and skipped rather than
   * taking the rest of the drill (or `busy`) down with it. On timeout,
   * actively cancels the stuck call (this.speech.cancel(), which resolves
   * its pending promise — see OpenAITTSProvider.cancel/playBlob) instead
   * of just abandoning it, so it can't still start playing later and
   * overlap with whatever the drill moves on to next.
   */
  private async speakDrillPart(text: string, timeoutMs: number, slow: boolean): Promise<void> {
    const speakFn = slow && this.speech.speakSlow ? this.speech.speakSlow.bind(this.speech) : this.speech.speak.bind(this.speech);
    let timedOut = false;
    let timer!: ReturnType<typeof setTimeout>;
    const speakPromise: Promise<void> = speakFn(text, { lang: "en-US" }).catch((err) => {
      // Still within the race (see below): let Promise.race see this
      // rejection so the outer catch logs it. Once the timeout has
      // already won, this is just the abandoned call settling late —
      // swallow it here instead of leaving an unhandled rejection.
      if (timedOut) {
        console.warn(`[drill] "${text}" falhou após o timeout já ter liberado a vez:`, err);
        return;
      }
      throw err;
    });
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        console.warn(`[drill] "${text}" não respondeu em ${timeoutMs}ms — cancelando e pulando`);
        this.speech.cancel();
        resolve();
      }, timeoutMs);
    });
    try {
      await Promise.race([speakPromise, timeoutPromise]);
    } catch (err) {
      console.warn(`[drill] "${text}" falhou, pulando:`, err);
    } finally {
      // Load-bearing: without this, a speak() that wins the race (settles
      // well under timeoutMs) leaves its timer armed — it would still
      // fire later and cancel() whatever's playing by then, which could
      // be an entirely different, unrelated turn.
      clearTimeout(timer);
    }
  }

  /**
   * Automatic "hear it, repeat it" pronunciation model that follows a
   * correction's spoken explanation: the corrected word/phrase at SLOW
   * speed (real TTS speed control via SpeechProvider.speakSlow — see
   * OpenAITTSProvider — not a pitch-shifted playback hack), a beat of
   * silence, then the cue to try it themselves. Only 2 /api/tts calls, not
   * 3 — the normal-speed pass was cut (see the Falar-button-freeze
   * investigation): a student who just got something wrong needs to hear
   * it slow, not fast first, and 3 short calls back to back is what
   * turned this drill into a ~75s worst-case freeze. The 🔊/🐢 buttons on
   * the correction card (see CorrectionCard/MiniCorrectionCard) are still
   * there for the student to replay either speed as many times as they
   * want, at their own pace. Called as speakPartsWithReveal's `after`
   * step so it runs inside the same SPEECH_START/END span as the
   * correction's explanation — the avatar stays "speaking" throughout
   * instead of dropping to idle mid-drill.
   *
   * Never throws (speakDrillPart already catches its own failures/
   * timeouts) — the try/catch here is defense in depth only, so a truly
   * unexpected error (e.g. a listener callback below throwing) can't
   * propagate up and skip speakPartsWithReveal's own cleanup
   * (replaceEntry + SPEECH_END). `busy` itself is NOT touched here — it's
   * already guaranteed to clear via runTurn's own try/finally around this
   * entire call chain (see setBusy); duplicating that here would risk
   * flipping it false before speakPartsWithReveal's post-drill cleanup
   * has actually run.
   */
  private async runPronunciationDrill(word: string): Promise<void> {
    const trimmed = word.trim();
    if (!trimmed) return;
    console.log("[speakParts] início (drill: devagar -> pausa -> now you try)");
    try {
      console.log("[speakParts] parte 1 (devagar) start");
      await this.speakDrillPart(trimmed, DRILL_SLOW_TIMEOUT_MS, true);
      console.log("[speakParts] parte 1 (devagar) end");
      console.log("[speakParts] pausa 600ms");
      await sleep(600);
      console.log("[speakParts] parte 2 (now you try) start");
      await this.speakDrillPart("Now you try.", DRILL_NORMAL_TIMEOUT_MS, false);
      console.log("[speakParts] parte 2 (now you try) end");
      for (const cb of this.awaitingRepeatListeners) cb();
    } catch (err) {
      console.warn("[drill] erro inesperado no drill:", err);
    } finally {
      console.log("[speakParts] concluído, busy →", this.busy);
    }
  }

  private pushEntry(entry: ChatEntry): void {
    this.entries = [...this.entries, entry];
    for (const cb of this.entryListeners) cb(this.entries);
  }

  private emitError(message: string): void {
    for (const cb of this.errorListeners) cb(message);
  }

  private setApiStatus(online: boolean): void {
    for (const cb of this.apiStatusListeners) cb(online);
  }

  private setTranscribing(transcribing: boolean): void {
    for (const cb of this.transcribingListeners) cb(transcribing);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
