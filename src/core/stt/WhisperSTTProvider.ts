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
/** getUserMedia() has no built-in timeout — on some Android/WebView
 * combinations a dismissed-without-choosing permission prompt (see
 * start()'s permission pre-check) or a flaky mic driver can leave the
 * returned promise pending forever instead of rejecting. Without this
 * race, that hang propagates all the way up through
 * orchestrator.startListening() and leaves the Falar button permanently
 * disabled with zero feedback — exactly the freeze this exists to prevent. */
const GET_USER_MEDIA_TIMEOUT_MS = 5000;
/** Same reasoning as the chat/TTS fetch timeouts — without this, a dead
 * connection while uploading the recording leaves `transcribing` stuck
 * true forever (see the class doc comment), which is what makes the Falar
 * button appear to freeze on a bad connection specifically. */
const STT_FETCH_TIMEOUT_MS = 15000;

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
  /** Rejects the in-flight start() call — set only while start() is
   * actually awaiting getUserMedia, used by abort() (see its doc comment)
   * to cancel a hung permission prompt/driver instead of leaving start()'s
   * promise pending forever. */
  private startReject: ((err: Error) => void) | null = null;
  /** AbortController for the in-flight /api/stt upload, if any — abort()
   * uses this to cancel a hung transcription request. */
  private uploadController: AbortController | null = null;
  /** Set only by abort() — lets transcribeAndFinish() tell "I was aborted
   * mid-flight, abort() already did the cleanup/emit('end') for me" apart
   * from "I completed (or failed) normally", which also leaves `finished`
   * true by the time transcribeAndFinish() runs (finishUtterance sets it
   * before calling transcribeAndFinish). Without this distinction, a
   * transcribeAndFinish() call resuming after its upload was aborted would
   * emit a second, spurious "end"/"error" on top of abort()'s already-
   * correct reset — surfacing a confusing error toast right after the
   * long-press escape hatch the student just used successfully. */
  private aborted = false;

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
    this.aborted = false;
    this.hasDetectedSpeech = false;
    this.lastLoudAt = 0;

    // If the student already dismissed the permission prompt without
    // choosing (browsers never re-prompt after that — see the class doc
    // comment), fail fast with a specific, legible reason instead of
    // calling getUserMedia and hoping it rejects promptly. Best-effort:
    // the Permissions API isn't universally supported, so a missing/
    // failing query just falls through to getUserMedia itself.
    try {
      const status = await navigator.permissions?.query?.({ name: "microphone" as PermissionName });
      if (status?.state === "denied") {
        throw new Error("PERMISSAO_MICROFONE_NEGADA");
      }
    } catch (err) {
      if ((err as Error).message === "PERMISSAO_MICROFONE_NEGADA") throw err;
      // Permissions API unavailable/unsupported for "microphone" in this
      // browser — not an error, just no pre-check available.
    }

    console.log("[STT] iniciando getUserMedia...");
    try {
      this.stream = await new Promise<MediaStream>((resolve, reject) => {
        this.startReject = reject;
        const timeoutId = window.setTimeout(() => {
          reject(new Error("GETUSERMEDIA_TIMEOUT"));
        }, GET_USER_MEDIA_TIMEOUT_MS);
        navigator.mediaDevices.getUserMedia({ audio: true }).then(
          (stream) => {
            window.clearTimeout(timeoutId);
            resolve(stream);
          },
          (err) => {
            window.clearTimeout(timeoutId);
            reject(err);
          }
        );
      });
    } catch (error) {
      const err = error as DOMException;
      console.error("[STT] erro getUserMedia:", error);
      console.error("[STT] nome do erro:", err?.name);
      console.error("[STT] mensagem:", err?.message);
      throw error; // preserved: orchestrator.startListening() catches this and surfaces ERROR state
    } finally {
      this.startReject = null;
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

  /**
   * Escape hatch for the Falar button's long-press reset (see
   * ForceSendButton / page.tsx) — forcibly tears down whatever this
   * provider is doing RIGHT NOW, regardless of which async step it's
   * stuck in, and guarantees "end" fires so the orchestrator can get back
   * to idle. Safe to call from any state, including before start() has
   * even resolved (cancels the pending getUserMedia/permission check) or
   * mid-upload (aborts the /api/stt fetch).
   */
  abort(): void {
    console.log("[WhisperSTT] abort() — reset forçado");
    if (this.finished) return;
    this.finished = true;
    this.aborted = true;

    // Cancels a hung getUserMedia/permission-prompt wait, if start() is
    // currently in that phase.
    this.startReject?.(new Error("ABORTED"));
    this.startReject = null;

    // Cancels a hung /api/stt upload, if transcribeAndFinish() is
    // currently in that phase.
    this.uploadController?.abort();
    this.uploadController = null;

    this.stopSilenceWatch();
    if (this.maxRecordingTimeoutHandle !== null) {
      clearTimeout(this.maxRecordingTimeoutHandle);
      this.maxRecordingTimeoutHandle = null;
    }
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.onstop = null; // don't let a stray onstop fire transcribeAndFinish after abort
      this.recorder.stop();
    }
    this.recorder = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.chunks = [];

    this.emit("end", "");
    this.stopResolve?.("");
    this.stopResolve = null;
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

      const controller = new AbortController();
      this.uploadController = controller;
      const timeoutId = window.setTimeout(() => controller.abort(), STT_FETCH_TIMEOUT_MS);

      let res: Response;
      try {
        res = await fetch("/api/stt", { method: "POST", body: form, signal: controller.signal });
      } catch (fetchErr) {
        if ((fetchErr as Error).name === "AbortError") {
          throw new Error("STT timeout: /api/stt não respondeu a tempo");
        }
        throw fetchErr;
      } finally {
        window.clearTimeout(timeoutId);
        this.uploadController = null;
      }
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
      // Only surface this as a real error if it wasn't abort() itself that
      // caused the rejection — see `aborted`'s doc comment. abort() has
      // already reset everything to idle by the time this catch runs; a
      // second "error" here would just confuse the student right after
      // their long-press reset worked.
      if (!this.aborted) this.emit("error", String(err));
    }

    this.recorder = null;
    this.stream = null;

    // See `aborted`'s doc comment: abort() already did this exact cleanup
    // (emit "end", resolve stopResolve) synchronously when it fired —
    // doing it again here would be a harmless-but-confusing duplicate.
    if (this.aborted) return;

    if (transcript) this.emit("final", { transcript, detectedLanguage });
    this.emit("end", transcript);
    this.stopResolve?.(transcript);
    this.stopResolve = null;
  }

  private emit(event: STTEvent, payload: unknown): void {
    for (const cb of this.listeners[event]) cb(payload);
  }
}
