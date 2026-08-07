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

export type ChatEntry =
  | { role: "user"; text: string }
  | { role: "tutor"; response: TutorResponse };

type EntriesListener = (entries: ChatEntry[]) => void;
type ErrorListener = (message: string) => void;
type ApiStatusListener = (online: boolean) => void;
type TranscribingListener = (transcribing: boolean) => void;

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

  private readonly entryListeners = new Set<EntriesListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly apiStatusListeners = new Set<ApiStatusListener>();
  private readonly transcribingListeners = new Set<TranscribingListener>();

  constructor(opts: ConversationOrchestratorOptions) {
    this.speech = opts.speech;
    this.stt = opts.stt;
    this.ai = opts.ai;
    this.avatar = opts.avatar;
    this.stateMachine = opts.stateMachine ?? new CharacterStateMachine();
    this.systemPrompt = opts.systemPrompt;
    this.sessionId = opts.sessionId ?? Math.random().toString(36).slice(2);

    this.stateMachine.subscribe((state) => {
      this.avatar.setState(state);
      // The avatar visually stays "listening" through a batch STT
      // provider's upload/transcription gap (see "transcribing" below) —
      // but the moment the state machine actually leaves "listening" for
      // any reason, that gap is over one way or another.
      if (state !== "listening") this.setTranscribing(false);
    });

    // Only re-binds the avatar's amplitude source to whichever <audio>
    // element is currently playing — does NOT drive the state machine.
    // A reply's speech can be spoken as multiple sequential speak() calls
    // (English part, then Portuguese part — see speakParts), and each
    // call fires its own provider-level "start"/"end". If those directly
    // dispatched SPEECH_START/SPEECH_END, the state machine would drop to
    // "idle" between parts, which would visually flicker the avatar out of
    // "speaking" and back between the two parts of one reply. speakParts
    // is the sole authority for SPEECH_START/END.
    this.speech.on("start", () => {
      this.avatar.onAudioElement(this.speech.getAudioElement?.() ?? null);
    });

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

  getState(): CharacterState {
    return this.stateMachine.getState();
  }

  isBusy(): boolean {
    return this.busy;
  }

  async startListening(): Promise<void> {
    if (this.busy || this.listeningStartInFlight) return;
    if (this.stateMachine.getState() === "listening") return; // already listening, nothing to do
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
   */
  async startLesson(opts: { studentName: string; currentLessonCode: string }): Promise<void> {
    this.studentName = opts.studentName;
    this.currentLessonCode = opts.currentLessonCode;
    const kickoff = "(Lesson start — do not repeat or quote this instruction back to the student.)";
    this.stateMachine.dispatch({ type: "STOP_LISTENING" }); // idle -> thinking
    await this.handleUserMessage(kickoff, undefined, { silent: true });
    // handleUserMessage ends back on "idle" once the tutor's opening line
    // finishes speaking. The mic stays closed until the student clicks
    // Falar — no auto-listen here or anywhere else in this class.
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
   * Scripted (non-AI) closing beat fired once by the lesson timer when it
   * hits 0. Puts the avatar in "praise" and speaks the fixed closing lines
   * — the completion card (see page.tsx) takes over from here, not
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
    this.busy = true;
    try {
      if (this.stateMachine.getState() === "listening") {
        await this.stt.stop().catch(() => {});
      }
      this.stateMachine.dispatch({ type: "RESET" }); // -> idle, from any state
      this.stateMachine.dispatch({ type: "STOP_LISTENING" }); // idle -> thinking
      if (opts.praiseFirst) await this.enterPraiseBeforeSpeaking();
      await this.speakParts(parts);
    } finally {
      this.busy = false;
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
    this.history = [];
    this.entries = [];
    for (const cb of this.entryListeners) cb(this.entries);
    this.busy = false;
    this.studentName = undefined;
    this.currentLessonCode = undefined;
    this.timeWarningActive = false;
    this.stateMachine.dispatch({ type: "RESET" });
  }

  private async handleUserMessage(
    text: string,
    detectedLanguage?: string,
    opts: { silent?: boolean } = {}
  ): Promise<void> {
    this.busy = true;
    if (!opts.silent) this.pushEntry({ role: "user", text });
    this.history.push({ role: "user", content: text });

    try {
      const messages: Message[] = [{ role: "system", content: this.systemPrompt }, ...this.history];
      const response = await this.ai.send(messages, {
        sessionId: this.sessionId,
        detectedLanguage,
        studentName: this.studentName,
        currentLessonCode: this.currentLessonCode,
        timeWarning: this.timeWarningActive,
      });
      this.setApiStatus(true);

      this.history.push({
        role: "assistant",
        content: [response.speech.english, response.speech.portuguese].filter((s) => s.trim()).join(" / "),
      });
      this.pushEntry({ role: "tutor", response });

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
      await this.speakParts(
        correction ? [portuguesePart, englishPart] : [englishPart, portuguesePart],
        correction ? { after: () => this.runPronunciationDrill(correction.corrected) } : {}
      );
      // speakParts has already brought the state machine back to idle by
      // the time it resolves — correction now overlays on top of that idle
      // state and reverts back to it on its own after ~1.5s. Praise already
      // happened above, before speaking.
      if (correction) this.stateMachine.dispatch({ type: "CORRECTION" });
    } catch (err) {
      this.setApiStatus(false);
      this.emitError(errorMessage(err));
      this.stateMachine.dispatch({ type: "ERROR" });
    } finally {
      this.busy = false;
    }
    // Mic stays closed once the tutor's done — push-to-talk only. The
    // student clicks Falar (see ForceSendButton's onClick in page.tsx)
    // when they're ready to answer; nothing here reopens it for them.
  }

  /**
   * Puts the avatar in the "praise" pose and waits for it to revert on its
   * own (CharacterStateMachine's transient timer, ~1.5s) before resolving —
   * that revert lands back on "thinking" (the persistent state captured
   * when PRAISE was dispatched, since a response always arrives while
   * still "thinking"), which is exactly the state speakParts' SPEECH_START
   * needs to transition out of next.
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
   * turn: dispatches SPEECH_START once before the first non-empty part
   * and SPEECH_END once after the last one (and after `opts.after`, if
   * given), regardless of how many actual speak() calls happen underneath.
   * This is what lets a bilingual reply (English part, then Portuguese
   * part) — or a correction's spoken explanation plus its automatic
   * pronunciation drill (see runPronunciationDrill) — play as one
   * continuous avatar "speaking" state instead of flickering back to idle
   * in between.
   */
  private async speakParts(
    parts: { text: string; lang: string }[],
    opts: { after?: () => Promise<void> } = {}
  ): Promise<void> {
    const nonEmpty = parts.filter((p) => p.text.trim().length > 0);
    if (nonEmpty.length === 0 && !opts.after) return;

    this.stateMachine.dispatch({ type: "SPEECH_START" });
    for (const part of nonEmpty) {
      await this.speech.speak(part.text, { lang: part.lang });
    }
    if (opts.after) await opts.after();
    this.stateMachine.dispatch({ type: "SPEECH_END" });
  }

  /**
   * Automatic "hear it, repeat it" pronunciation model that follows a
   * correction's spoken explanation: the corrected word/phrase at normal
   * speed, a beat of silence, the same word again at 0.65x speed (real TTS
   * speed control via SpeechProvider.speakSlow — see OpenAITTSProvider —
   * not a pitch-shifted playback hack), another beat, then the cue to try
   * it themselves. Called as speakParts' `after` step so it runs inside
   * the same SPEECH_START/END span as the correction's explanation — the
   * avatar stays "speaking" throughout instead of dropping to idle
   * mid-drill.
   */
  private async runPronunciationDrill(word: string): Promise<void> {
    const trimmed = word.trim();
    if (!trimmed) return;
    await this.speech.speak(trimmed, { lang: "en-US" });
    await sleep(800);
    if (this.speech.speakSlow) await this.speech.speakSlow(trimmed, { lang: "en-US" });
    else await this.speech.speak(trimmed, { lang: "en-US" });
    await sleep(500);
    await this.speech.speak("Now you try.", { lang: "en-US" });
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
