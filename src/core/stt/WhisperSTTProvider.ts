import type { SpeechToTextProvider, STTEvent } from "./SpeechToTextProvider";

type Listener = (payload: unknown) => void;

/**
 * STT via Groq's Whisper endpoint (server-side proxy at /api/stt — the
 * GROQ_API_KEY never touches the browser). Pure push-to-talk: start()
 * opens the mic and records; the recording only ever stops when the caller
 * explicitly calls stop() (the Falar button clicked again — see
 * ForceSendButton / orchestrator.stopListening). There is no silence
 * detection, no auto-finish, and no give-up timeout — the mic stays open
 * for as long as the student wants until they click again.
 *
 * There is no live partial transcription like BrowserSTTProvider's
 * streaming recognizer — "partial" never fires, only "transcribing"
 * (upload in flight) then "final".
 *
 * Privacy: the recorded audio only ever exists in memory — this
 * provider's MediaRecorder buffer, and the /api/stt request body — never
 * written to disk or a database, client or server side. It's discarded
 * the instant the transcript comes back (see /api/stt/route.ts).
 */
export class WhisperSTTProvider implements SpeechToTextProvider {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stopResolve: ((text: string) => void) | null = null;
  private finished = false;

  private readonly listeners: Record<STTEvent, Set<Listener>> = {
    partial: new Set(),
    final: new Set(),
    error: new Set(),
    end: new Set(),
    transcribing: new Set(),
  };

  async start(): Promise<void> {
    this.chunks = [];
    this.finished = false;

    console.log("[STT] iniciando getUserMedia...");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const err = error as DOMException;
      console.error("[STT] erro getUserMedia:", error);
      console.error("[STT] nome do erro:", err?.name);
      console.error("[STT] mensagem:", err?.message);
      throw error; // preserved: orchestrator.startListening() catches this and surfaces ERROR state
    }

    const recorder = new MediaRecorder(this.stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder = recorder;
    recorder.start();

    console.log("[WhisperSTT] listening started (push-to-talk, manual stop only)");
  }

  /** The only way an utterance ever finishes: the student clicked Falar
   * again (see ForceSendButton / orchestrator.stopListening). */
  stop(): Promise<string> {
    return new Promise((resolve) => {
      if (this.finished || !this.recorder || this.recorder.state === "inactive") {
        resolve("");
        return;
      }
      this.stopResolve = resolve;
      console.log("[WhisperSTT] manual stop — finishing utterance");
      this.finishUtterance();
    });
  }

  on(event: STTEvent, cb: Listener): () => void {
    this.listeners[event].add(cb);
    return () => this.listeners[event].delete(cb);
  }

  private finishUtterance(): void {
    if (this.finished) return;
    this.finished = true;

    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") {
      void this.transcribeAndFinish();
      return;
    }
    recorder.onstop = () => void this.transcribeAndFinish();
    recorder.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
  }

  private async transcribeAndFinish(): Promise<void> {
    console.log("[WhisperSTT] recording stopped, uploading for transcription");
    this.emit("transcribing", true);
    const clientStart = performance.now();

    const mimeType = this.recorder?.mimeType || "audio/webm";
    const blob = new Blob(this.chunks, { type: mimeType });
    this.chunks = []; // drop our reference immediately — nothing here is persisted

    let transcript = "";
    let detectedLanguage: string | undefined;
    try {
      const form = new FormData();
      form.append("audio", blob, "audio.webm");
      // No "lang" field — let Whisper auto-detect (see class doc comment).

      const res = await fetch("/api/stt", { method: "POST", body: form });
      const clientLatencyMs = Math.round(performance.now() - clientStart);

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error("[WhisperSTT] transcription failed", res.status, errText);
        this.emit("error", `HTTP ${res.status}`);
      } else {
        const data: { transcript?: string; detectedLanguage?: string; serverLatencyMs?: number } =
          await res.json();
        transcript = (data.transcript ?? "").trim();
        detectedLanguage = data.detectedLanguage;
        console.log("[WhisperSTT] latency", {
          clientMs: clientLatencyMs, // silence detected (or forced) -> transcript usable here
          groqApiMs: data.serverLatencyMs, // our server's round trip to Groq
          transcript,
          detectedLanguage,
        });
      }
    } catch (err) {
      console.error("[WhisperSTT] network error", err);
      this.emit("error", String(err));
    }

    this.recorder = null;
    this.stream = null;

    if (transcript) this.emit("final", { transcript, detectedLanguage });
    this.emit("end", transcript);
    this.stopResolve?.(transcript);
    this.stopResolve = null;
  }

  private emit(event: STTEvent, payload: unknown): void {
    for (const cb of this.listeners[event]) cb(payload);
  }
}
