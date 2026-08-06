import type { SpeechToTextProvider, STTEvent } from "./SpeechToTextProvider";

type Listener = (payload: unknown) => void;

export interface VadOptions {
  /** RMS energy (roughly 0-1) above which audio counts as "speech". Needs
   * calibration per mic/room — a noisy environment may need this raised. */
  speechEnergyThreshold?: number;
  /** How long energy must stay below the threshold, after speech was heard,
   * before the utterance is considered finished and auto-sent. Too short
   * cuts off mid-sentence pauses (breathing, hesitation); too long makes
   * the tutor feel slow to respond. */
  silenceDurationMs?: number;
  /** Speech must be sustained at least this long before a silence gap is
   * allowed to end the utterance — filters out a single short noise blip
   * from being treated as "the student spoke, then went silent". */
  minSpeechDurationMs?: number;
  /** While a speech blip hasn't yet reached minSpeechDurationMs, this is
   * how long it's allowed to go quiet before being discarded as noise
   * (a cough, a click) rather than kept waiting on indefinitely. Shorter
   * than silenceDurationMs on purpose — an unconfirmed blip should give up
   * faster than a confirmed sentence waiting for its real ending. */
  noiseResetMs?: number;
  /** Safety net: if no CONFIRMED speech happens (student says nothing —
   * stepped away, mic issue, or only noise blips that never turn into real
   * speech), stop listening and go back to idle instead of recording
   * forever. No transcription call is made in this case. */
  maxWaitForSpeechMs?: number;
}

const DEFAULT_VAD: Required<VadOptions> = {
  speechEnergyThreshold: 0.02,
  silenceDurationMs: 1300,
  minSpeechDurationMs: 300,
  noiseResetMs: 600,
  maxWaitForSpeechMs: 20000,
};

/**
 * STT via Groq's Whisper endpoint (server-side proxy at /api/stt — the
 * GROQ_API_KEY never touches the browser). Records continuously from
 * start() and uses simple energy-based VAD (Web Audio AnalyserNode) to
 * detect when the student has finished a sentence — speech followed by a
 * silence gap — and auto-finishes the utterance with no click required.
 * stop() remains available as a manual override (see spec item 5) that
 * force-finishes immediately regardless of what VAD is seeing.
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

  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private vadRafHandle: number | null = null;
  private finished = false;

  private readonly vad: Required<VadOptions>;

  private readonly listeners: Record<STTEvent, Set<Listener>> = {
    partial: new Set(),
    final: new Set(),
    error: new Set(),
    end: new Set(),
    transcribing: new Set(),
  };

  constructor(vadOptions: VadOptions = {}) {
    this.vad = { ...DEFAULT_VAD, ...vadOptions };
  }

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

    this.startVadMonitor();
    console.log("[WhisperSTT] listening started (continuous, VAD-driven)");
  }

  /** Manual fallback (spec item 5): force-finish right now, regardless of
   * what VAD has or hasn't detected yet. */
  stop(): Promise<string> {
    return new Promise((resolve) => {
      if (this.finished || !this.recorder || this.recorder.state === "inactive") {
        resolve("");
        return;
      }
      this.stopResolve = resolve;
      console.log("[WhisperSTT] manual force-send");
      this.finishUtterance();
    });
  }

  on(event: STTEvent, cb: Listener): () => void {
    this.listeners[event].add(cb);
    return () => this.listeners[event].delete(cb);
  }

  private startVadMonitor(): void {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx || !this.stream) {
      console.error("[WhisperSTT] Web Audio unavailable — VAD disabled, falling back to manual stop() only");
      return;
    }

    const audioCtx = new AudioCtx();
    const source = audioCtx.createMediaStreamSource(this.stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    // Analysis only — deliberately NOT connected to audioCtx.destination,
    // so the student doesn't hear their own mic echoed back.
    source.connect(analyser);

    this.audioCtx = audioCtx;
    this.analyser = analyser;

    const data = new Uint8Array(analyser.frequencyBinCount);
    const startedAt = performance.now();
    let speechDetectedAt: number | null = null;
    let lastAboveThresholdAt: number | null = null;

    const tick = () => {
      if (this.finished) return;

      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / data.length);

      const now = performance.now();

      if (rms > this.vad.speechEnergyThreshold) {
        if (speechDetectedAt === null) {
          speechDetectedAt = now;
          console.log("[WhisperSTT/VAD] speech detected (tentative)");
        }
        lastAboveThresholdAt = now;
      }

      if (speechDetectedAt !== null) {
        const anchor = lastAboveThresholdAt ?? speechDetectedAt;
        const spanMs = anchor - speechDetectedAt;
        const silenceMs = now - anchor;

        if (spanMs >= this.vad.minSpeechDurationMs) {
          // Confirmed real speech — now watching for the trailing silence
          // that marks the end of the sentence.
          if (silenceMs >= this.vad.silenceDurationMs) {
            console.log("[WhisperSTT/VAD] silence after speech — auto-finishing", {
              spanMs: Math.round(spanMs),
              silenceMs: Math.round(silenceMs),
            });
            this.finishUtterance();
            return;
          }
        } else if (silenceMs >= this.vad.noiseResetMs) {
          // Never reached minSpeechDurationMs before going quiet again —
          // a blip, not a sentence. Discard it and keep listening fresh,
          // instead of getting stuck waiting on a span that can't grow.
          console.log("[WhisperSTT/VAD] discarding noise blip, resuming wait for real speech");
          speechDetectedAt = null;
          lastAboveThresholdAt = null;
        }
      }

      if (speechDetectedAt === null && now - startedAt >= this.vad.maxWaitForSpeechMs) {
        console.log("[WhisperSTT/VAD] no speech detected within max wait — giving up silently");
        this.abortWithoutTranscribing();
        return;
      }

      this.vadRafHandle = requestAnimationFrame(tick);
    };
    this.vadRafHandle = requestAnimationFrame(tick);
  }

  private stopVadMonitor(): void {
    if (this.vadRafHandle !== null) {
      cancelAnimationFrame(this.vadRafHandle);
      this.vadRafHandle = null;
    }
    this.analyser = null;
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  /** No speech at all before maxWaitForSpeechMs — reset to idle, no
   * transcription call, no error surfaced (this is a normal timeout, not
   * a failure). */
  private abortWithoutTranscribing(): void {
    if (this.finished) return;
    this.finished = true;
    this.stopVadMonitor();

    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.recorder = null;
    this.stream = null;
    this.chunks = [];

    this.emit("end", "");
    this.stopResolve?.("");
    this.stopResolve = null;
  }

  private finishUtterance(): void {
    if (this.finished) return;
    this.finished = true;
    this.stopVadMonitor();

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
