import type { SpeechToTextProvider, STTEvent } from "./SpeechToTextProvider";

type Listener = (payload: unknown) => void;

/**
 * Default STT implementation: the browser's native SpeechRecognition
 * (Web Speech API), with webkitSpeechRecognition as the Chrome fallback.
 *
 * IMPORTANT: with continuous=false, the browser stops listening on its own
 * as soon as it detects silence — onend fires WITHOUT the caller ever
 * calling stop(). Do not gate delivering the transcript behind an explicit
 * stop() call; always emit "final"/"end" from the recognition callbacks
 * themselves, and let stop()'s returned promise be a secondary,
 * best-effort convenience for callers that *do* call it manually.
 */
export class BrowserSTTProvider implements SpeechToTextProvider {
  private recognition: SpeechRecognition | null = null;
  private finalText = "";
  private stopResolve: ((text: string) => void) | null = null;

  private readonly listeners: Record<STTEvent, Set<Listener>> = {
    partial: new Set(),
    final: new Set(),
    error: new Set(),
    end: new Set(),
    transcribing: new Set(), // never emitted — this engine transcribes live, no upload gap
    amplitude: new Set(), // never emitted — no analyser here, no real amplitude to report
  };

  constructor(private readonly lang: string = "en-US") {}

  async start(lang?: string): Promise<void> {
    const recognition = this.ensureRecognition();
    if (!recognition) {
      throw new Error("SpeechRecognition não suportado neste navegador");
    }
    if (lang) recognition.lang = lang;
    this.finalText = "";
    console.log("[STT] start()", { lang: recognition.lang });
    recognition.start();
  }

  stop(): Promise<string> {
    return new Promise((resolve) => {
      if (!this.recognition) {
        resolve(this.finalText);
        return;
      }
      this.stopResolve = resolve;
      console.log("[STT] stop() requested by caller");
      this.recognition.stop();
    });
  }

  on(event: STTEvent, cb: Listener): () => void {
    this.listeners[event].add(cb);
    return () => this.listeners[event].delete(cb);
  }

  private ensureRecognition(): SpeechRecognition | null {
    if (this.recognition) return this.recognition;

    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SR) {
      console.error("[STT] SpeechRecognition/webkitSpeechRecognition indisponível neste navegador");
      return null;
    }

    const recognition = new SR();
    recognition.lang = this.lang;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const result = event.results[event.results.length - 1];
      const transcript = (result?.[0]?.transcript ?? "").trim();

      if (result) {
        const alternatives: { transcript: string; confidence: number }[] = [];
        for (let i = 0; i < result.length; i++) {
          alternatives.push({ transcript: result[i].transcript, confidence: result[i].confidence });
        }
        console.log("[STT] alternatives", alternatives);
        if (alternatives.length > 1) {
          const [best, second] = alternatives;
          const gap = Math.abs((best.confidence ?? 0) - (second.confidence ?? 0));
          if (gap < 0.15) {
            console.warn("[STT] ambiguous result — top 2 alternatives have close confidence", {
              gap,
              best,
              second,
            });
          }
        }
      }

      console.log("[STT] onresult", {
        isFinal: result?.isFinal,
        transcript,
        confidence: result?.[0]?.confidence,
      });

      if (result?.isFinal) {
        this.finalText = transcript;
        // This is the actual delivery path — fires here regardless of
        // whether stop() was ever called, which is what makes the
        // browser's auto-stop-on-silence behavior work correctly.
        this.emit("final", { transcript });
      } else {
        this.emit("partial", transcript);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error("[STT] onerror", event.error, event.message);
      this.emit("error", event.error);
      this.resolveStop();
    };

    recognition.onend = () => {
      console.log("[STT] onend", { finalText: this.finalText });
      this.resolveStop();
      this.emit("end", this.finalText);
    };

    this.recognition = recognition;
    return recognition;
  }

  private resolveStop(): void {
    this.stopResolve?.(this.finalText);
    this.stopResolve = null;
  }

  private emit(event: STTEvent, payload: unknown): void {
    for (const cb of this.listeners[event]) cb(payload);
  }
}
