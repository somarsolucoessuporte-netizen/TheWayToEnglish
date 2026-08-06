import type { SpeechProvider } from "../speech/SpeechProvider";
import type { SpeechToTextProvider, SttResult } from "../stt/SpeechToTextProvider";
import type { AIProvider, Message } from "../ai/AIProvider";
import { speechLangFor, type TutorResponse } from "../ai/TutorResponse";
import type { AvatarEngine } from "../avatar-engine/AvatarEngine";
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
  /** Hands-free voice mode: once true (set by startLesson), the orchestrator
   * auto-restarts listening every time the state machine settles back on
   * "idle" — no push-to-talk click needed for each turn. VAD inside the
   * active SpeechToTextProvider (see WhisperSTTProvider) decides when the
   * student is done talking. */
  private voiceModeEnabled = false;

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
      // Hands-free loop: every time we land back on "idle" (after the
      // tutor finishes speaking, or a praise/correction overlay reverts),
      // start listening again on our own — no button press per turn.
      if (state === "idle" && this.voiceModeEnabled) void this.startListening();
    });

    this.speech.on("start", () => {
      this.avatar.onAudioElement(this.speech.getAudioElement?.() ?? null);
      this.stateMachine.dispatch({ type: "SPEECH_START" });
    });
    this.speech.on("end", () => this.stateMachine.dispatch({ type: "SPEECH_END" }));
    this.speech.on("error", () => this.stateMachine.dispatch({ type: "SPEECH_END" }));

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
    if (this.busy) return;
    this.setTranscribing(false);
    try {
      await this.stt.start();
      this.stateMachine.dispatch({ type: "START_LISTENING" });
    } catch (err) {
      this.emitError(errorMessage(err));
      this.stateMachine.dispatch({ type: "ERROR" });
    }
  }

  /**
   * Manual override (spec item 5): force the current utterance to send
   * right now, without waiting for VAD to detect a silence gap — e.g. the
   * student clicked "Enviar agora", or the room is too noisy for silence
   * detection to work. The actual state transition and message handling
   * happen in the "final"/"end" listeners wired in the constructor — not
   * here — because a hands-free provider may have already finished the
   * utterance on its own (via VAD) before this is even called.
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
    this.voiceModeEnabled = true;
    const kickoff = "(Lesson start — do not repeat or quote this instruction back to the student.)";
    this.stateMachine.dispatch({ type: "STOP_LISTENING" }); // idle -> thinking
    await this.handleUserMessage(kickoff, undefined, { silent: true });
    // handleUserMessage ends back on "idle" (or a praise/correction overlay
    // on top of it) once the tutor's opening line finishes speaking, which
    // triggers the very first auto-listen via the subscribe hook above.
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
      });
      this.setApiStatus(true);

      this.history.push({ role: "assistant", content: response.speech });
      this.pushEntry({ role: "tutor", response });

      await this.speech.speak(response.speech, { lang: speechLangFor(response.language) });
      // SPEECH_END (wired in the constructor) has already brought the
      // state machine back to idle by the time speak() resolves — praise/
      // correction now overlays on top of that idle state and reverts
      // back to it on its own after ~1.5s.
      if (response.correction) this.stateMachine.dispatch({ type: "CORRECTION" });
      else if (response.praise) this.stateMachine.dispatch({ type: "PRAISE" });
    } catch (err) {
      this.setApiStatus(false);
      this.emitError(errorMessage(err));
      this.stateMachine.dispatch({ type: "ERROR" });
    } finally {
      this.busy = false;
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
