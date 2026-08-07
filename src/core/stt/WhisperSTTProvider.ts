import type { SpeechToTextProvider, STTEvent } from "./SpeechToTextProvider";

type Listener = (payload: unknown) => void;

/** RMS amplitude below which the mic is considered silent — see the
 * auto-stop VAD in startSilenceWatch. Speech typically sits well above
 * this; ambient room noise typically sits below it. */
const SILENCE_THRESHOLD_RMS = 0.015;
/** How long the mic must stay below SILENCE_THRESHOLD_RMS, continuously,
 * before an utterance auto-finishes — long enough that a language
 * learner's mid-sentence thinking pause doesn't get mistaken for "done
 * talking". Do not shorten this: cutting off too fast is what push-to-
 * talk's original second click was specifically avoiding. */
const SILENCE_DURATION_MS = 1800;
/** How often the analyser is sampled for both the auto-stop VAD and the
 * "amplitude" event the UI uses for real sound-wave bars. */
const SAMPLE_INTERVAL_MS = 50;
/** Hard ceiling on a single recording — sends whatever's been said so far
 * rather than recording forever if the student just keeps talking, or
 * something goes wrong with silence detection. */
const MAX_RECORDING_MS = 30000;

/**
 * STT via Groq's Whisper endpoint (server-side proxy at /api/stt — the
 * GROQ_API_KEY never touches the browser). Push-to-talk to OPEN the mic —
 * start() is only ever called from the Falar button's onClick (see
 * orchestrator.startListening) — that rule is unchanged. What's changed
 * is how the recording CLOSES: it now stops itself once the student
 * actually stops talking (a real energy-based VAD over the mic stream,
 * see startSilenceWatch), instead of requiring a second manual click.
 * stop() is kept as an explicit override — the Falar button stays
 * clickable throughout, for a student who wants to force-send before the
 * silence timer would.
 *
 * There is no live partial transcription like BrowserSTTProvider's
 * streaming recognizer — "partial" never fires, only "transcribing"
 * (upload in flight) then "final". "amplitude" fires continuously while
 * recording with the mic's real RMS, so the UI's sound-wave indicator
 * (see ForceSendButton) reacts to actual voice instead of a canned loop.
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

  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sampleIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private maxRecordingTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  /** Set the first time RMS crosses SILENCE_THRESHOLD_RMS — silence
   * counting (see startSilenceWatch) never starts before the student has
   * actually said something at least once, so a slow starter never gets
   * cut off before they've begun. */
  private hasDetectedSpeech = false;
  /** performance.now() of the last sample AT OR ABOVE the silence
   * threshold — the auto-stop fires once "now" is SILENCE_DURATION_MS
   * past this. */
  private lastLoudAt = 0;

  private readonly listeners: Record<STTEvent, Set<Listener>> = {
    partial: new Set(),
    final: new Set(),
    error: new Set(),
    end: new Set(),
    transcribing: new Set(),
    amplitude: new Set(),
  };

  async start(): Promise<void> {
    this.chunks = [];
    this.finished = false;
    this.hasDetectedSpeech = false;
    this.lastLoudAt = 0;

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

    this.startSilenceWatch();
    this.maxRecordingTimeoutHandle = setTimeout(() => {
      console.log("[WhisperSTT] limite de 30s atingido — enviando automaticamente");
      this.finishUtterance();
    }, MAX_RECORDING_MS);

    console.log("[WhisperSTT] listening started (auto-stop on silence, manual stop still available)");
  }

  /** Manual override: the student clicked Falar again while already
   * listening (see ForceSendButton / orchestrator.stopListening) — ends
   * the recording right now instead of waiting for the silence VAD or the
   * 30s ceiling. */
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

  /** Energy-based VAD purely for the auto-stop decision and the
   * real-time "amplitude" event the UI's sound-wave bars react to —
   * entirely separate from MediaRecorder, which keeps recording the
   * actual audio regardless of what this measures. Deliberately NOT
   * connected to audioCtx.destination, so the student never hears their
   * own mic echoed back. Failing to set up (Web Audio unavailable, or the
   * AnalyserNode construction throws) just means no auto-stop — stop()
   * and the 30s ceiling still work, so this never blocks recording. */
  private startSilenceWatch(): void {
    if (!this.stream) return;
    const AudioCtx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      console.error(
        "[WhisperSTT] Web Audio indisponível — sem auto-stop por silêncio, só stop() manual e o limite de 30s"
      );
      return;
    }

    try {
      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(this.stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      this.audioCtx = audioCtx;
      this.analyser = analyser;
    } catch (err) {
      console.error("[WhisperSTT] falha ao criar AnalyserNode — sem auto-stop por silêncio:", err);
      return;
    }

    const analyser = this.analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);

    this.sampleIntervalHandle = setInterval(() => {
      if (this.finished) return;
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      this.emit("amplitude", rms);

      const now = performance.now();
      if (rms >= SILENCE_THRESHOLD_RMS) {
        this.hasDetectedSpeech = true;
        this.lastLoudAt = now;
        return;
      }

      // Silence-counting only ever starts after real speech has actually
      // been heard at least once — a student who clicked Falar and is
      // still gathering their thoughts must never get cut off before
      // they've said anything (see the class doc comment).
      if (!this.hasDetectedSpeech) return;

      if (now - this.lastLoudAt >= SILENCE_DURATION_MS) {
        console.log("[WhisperSTT] silêncio de 1.8s detectado — enviando automaticamente");
        this.finishUtterance();
      }
    }, SAMPLE_INTERVAL_MS);
  }

  private stopSilenceWatch(): void {
    if (this.sampleIntervalHandle !== null) {
      clearInterval(this.sampleIntervalHandle);
      this.sampleIntervalHandle = null;
    }
    this.analyser = null;
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  private finishUtterance(): void {
    if (this.finished) return;
    this.finished = true;
    this.stopSilenceWatch();
    if (this.maxRecordingTimeoutHandle !== null) {
      clearTimeout(this.maxRecordingTimeoutHandle);
      this.maxRecordingTimeoutHandle = null;
    }

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
