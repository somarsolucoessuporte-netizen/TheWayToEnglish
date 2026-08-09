import type { SpeechEvent, SpeechOptions, SpeechProvider } from "./SpeechProvider";

type Listener = (e?: unknown) => void;

/** Slower-than-normal playback speed used for the "hear it, repeat it"
 * pronunciation model (see SpeechProvider.speakSlow) — passed straight
 * through to OpenAI's TTS `speed` parameter, not a client-side
 * playbackRate hack, so it stays crisp instead of sounding pitched down. */
const SLOW_SPEED = 0.65;
/** Without this, a stalled /api/tts request never resolves OR rejects —
 * leaving the orchestrator's runTurn() awaiting speak() forever, which is
 * indistinguishable from a frozen app to the student (no error, no state
 * change, the Falar button just stops responding on the NEXT turn since
 * busy never clears). */
const TTS_FETCH_TIMEOUT_MS = 15000;
/** Watchdog for the rarer case where audio.play() resolves (autoplay was
 * allowed) but "playing" never actually fires — a stalled decode, a dead
 * connection mid-download. Without this, playBlob's promise (and whatever
 * called speak()) waits forever with no error and no way out. */
const PLAYBACK_START_TIMEOUT_MS = 10000;

/**
 * Speaks by requesting audio from /api/tts (a server route that holds the
 * OPENAI_API_KEY secret and calls OpenAI's /v1/audio/speech) and playing
 * the returned MP3 through a real <audio> element.
 */
export class OpenAITTSProvider implements SpeechProvider {
  private audio: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;
  private speaking = false;
  /** Resolver for the in-flight speakAtSpeed() promise, if any — cancel()
   * calls this so an interruption (orchestrator.reset() / forceAnnounce())
   * can't leave a previous speak() call awaiting forever on an "ended"
   * event that a paused, abandoned <audio> element will never fire. */
  private pendingResolve: (() => void) | null = null;
  /** Single <audio> element unlocked by the first real user gesture on the
   * page — see unlockAudioElement/playBlob. iOS Safari's autoplay grant is
   * tied to the SPECIFIC element that played inside a genuine gesture, not
   * to the page as a whole, so a fresh `new Audio(url)` on every turn (the
   * old behavior) only ever autoplays successfully once: the very first
   * turn, which rides on the gesture that started the lesson. Every turn
   * after that silently fails to produce sound on iOS — text still
   * arrives (the /api/chat call itself has nothing to do with playback),
   * which matches exactly the "works once, then text-only" bug reported. */
  private unlockedAudioEl: HTMLAudioElement | null = null;
  private readonly listeners: Record<SpeechEvent, Set<Listener>> = {
    start: new Set(),
    end: new Set(),
    error: new Set(),
  };

  constructor() {
    // SSR guard: this class is instantiated once at module scope (see
    // app-config/providers.ts's `export const speechProvider = new
    // OpenAITTSProvider()`), which also runs during Next.js's server-side
    // render of the "use client" page that imports it — `document` isn't
    // defined there. Every other browser API in this file is only ever
    // touched from inside methods, called at runtime in the browser; this
    // constructor is the one exception, so it needs its own guard.
    if (typeof document === "undefined") return;
    const unlock = () => {
      document.removeEventListener("click", unlock);
      document.removeEventListener("touchend", unlock);
      this.unlockAudioElement();
    };
    document.addEventListener("click", unlock, { once: true });
    document.addEventListener("touchend", unlock, { once: true });
  }

  /** Standard iOS Safari unlock trick: play (and immediately pause) a
   * silent audio file on THIS element, synchronously inside a real user
   * gesture (see the constructor's click/touchend listener). Safari then
   * treats this specific element as permanently allowed to autoplay for
   * the rest of the page's lifetime, regardless of what .src it's given
   * afterward — see playBlob, which reuses this same element every turn
   * instead of constructing a new one. */
  private unlockAudioElement(): void {
    if (this.unlockedAudioEl) return;
    const el = new Audio();
    el.src =
      "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8fgCUpsYSCBFQkoiawwkAU3Lt1KwCMFHZEYEGxQGQtQkBMEyfZo0bwQOFDiw/JylTln4flJSt8/9e+zl63znSpe6cp913//1q3sk0VKAFoAYJDgBm2RwYBtThe";
    void el.play().catch(() => {});
    el.pause();
    this.unlockedAudioEl = el;
    console.log("[TTS] audioEl destravado no primeiro gesto");
  }

  async speak(text: string, opts: SpeechOptions = {}): Promise<void> {
    return this.speakAtSpeed(text, 1.0, opts.lang);
  }

  /** See SpeechProvider.speakSlow. */
  async speakSlow(text: string, opts: SpeechOptions = {}): Promise<void> {
    return this.speakAtSpeed(text, SLOW_SPEED, opts.lang);
  }

  private async speakAtSpeed(text: string, speed: number, lang?: string): Promise<void> {
    try {
      console.log("[TTS] iniciando...");
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), TTS_FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, speed }),
          signal: controller.signal,
        });
      } catch (fetchErr) {
        if ((fetchErr as Error).name === "AbortError") {
          throw new Error("TTS timeout: /api/tts não respondeu a tempo");
        }
        throw fetchErr;
      } finally {
        window.clearTimeout(timeoutId);
      }
      console.log("[TTS] status:", response.status);
      if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);

      const arrayBuffer = await response.arrayBuffer();
      console.log("[TTS] blob size:", arrayBuffer.byteLength);
      await this.playBlob(new Blob([arrayBuffer], { type: "audio/mpeg" }));
    } catch (err) {
      // Explicit, not silent: log here AND rethrow so the orchestrator's
      // existing error handling (ERROR state, error toast) actually fires
      // instead of the conversation quietly proceeding as if nothing
      // happened — this used to only emit locally, which nothing outside
      // this class was guaranteed to surface.
      console.error("[OpenAI TTS] erro:", err);
      console.error("[TTS] ERRO:", (err as Error)?.name, (err as Error)?.message);
      // Fallback: /api/tts itself failed (fetch error, timeout, non-2xx
      // HTTP, or playBlob's watchdog rejecting because "playing" never
      // fired — see playBlob) — try the browser's own speechSynthesis
      // before giving up, so the student hears SOMETHING instead of the
      // turn dying silently. Only emit "error" (see the single point of
      // truth below) if the fallback ALSO fails — a successful fallback
      // means the turn recovered, so no error should surface for it.
      try {
        await this.fallbackSpeak(text, lang, speed);
        return;
      } catch (fallbackErr) {
        console.error("[TTS] fallback também falhou:", fallbackErr);
        this.emit("error", err);
        throw err;
      }
    }
  }

  /** Last-resort fallback when /api/tts is unreachable, errors, or the
   * audio it returns never actually starts playing (see playBlob's
   * watchdog) — speaks directly through the browser's built-in
   * speechSynthesis instead of OpenAI's voice. Lower quality (robotic, no
   * custom voice), but keeps the lesson moving instead of the Falar
   * button staying stuck behind a dead network call. `rate` reuses the
   * same speed value speakAtSpeed already computed (1.0 normal,
   * SLOW_SPEED for the "hear it slow" drill). */
  private fallbackSpeak(text: string, lang: string | undefined, rate: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!("speechSynthesis" in window)) {
        reject(new Error("speechSynthesis indisponível"));
        return;
      }
      console.warn("[TTS] fallback para browser (speechSynthesis)");
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang || "en-US";
      u.rate = rate;
      u.onstart = () => this.emit("start");
      u.onend = () => {
        this.emit("end");
        resolve();
      };
      u.onerror = (e) => reject(e);
      window.speechSynthesis.speak(u);
    });
  }

  /** See SpeechProvider.speakBlob — plays an already-fetched MP3 blob
   * (e.g. from a boot-time greeting prefetch) with no network round trip. */
  async speakBlob(blob: Blob): Promise<void> {
    try {
      await this.playBlob(blob);
    } catch (err) {
      console.error("[OpenAI TTS] erro (blob pré-carregado):", err);
      this.emit("error", err);
      throw err;
    }
  }

  /** Shared by speakAtSpeed (fresh /api/tts fetch) and speakBlob (already
   * have the audio) — everything from "here's a Blob" onward is identical
   * either way: reuse (or create, as a fallback) the <audio> element, wire
   * the same "playing"/"ended"/"error" handlers, play it. */
  private async playBlob(blob: Blob): Promise<void> {
    this.cancel();
    const url = URL.createObjectURL(blob);
    console.log("[TTS] blob criado:", url);
    // Reuse the element unlocked by the first user gesture (see
    // unlockAudioElement) instead of `new Audio(url)` every turn — that
    // fresh-element approach is exactly what broke autoplay on iOS after
    // the first turn. Falls back to a throwaway fresh element only if the
    // gesture listener somehow hasn't fired yet (shouldn't happen in
    // practice: the whole app is gated behind the profile-picker click).
    const audio = this.unlockedAudioEl ?? new Audio();
    audio.src = url;
    console.log("[TTS] audioEl reutilizado, src:", audio.src.slice(0, 40));
    this.audio = audio;
    this.currentUrl = url;

    await new Promise<void>((resolve, reject) => {
      // Wrapping resolve so cancel() can also settle this promise (and
      // clear the ref) if it interrupts before "ended"/"error" ever fire.
      const finish = () => {
        window.clearTimeout(startWatchdog);
        this.pendingResolve = null;
        resolve();
      };
      this.pendingResolve = finish;

      // Watchdog for the case where audio.play() resolved (autoplay was
      // permitted) but "playing" never actually fires — a stalled decode,
      // a dead connection mid-download, or (notably on iOS Safari) the
      // platform's autoplay policy silently blocking playback even
      // though .play() itself didn't reject. REJECTS (not resolves) so
      // speakAtSpeed's catch can fall back to speechSynthesis — this is
      // the one settling path here that means "the student heard nothing
      // at all", unlike onended/onerror/cancel() below, which all follow
      // some real audio activity having happened.
      const startWatchdog = window.setTimeout(() => {
        console.error("[TTS] watchdog: 'playing' não disparou em", PLAYBACK_START_TIMEOUT_MS, "ms");
        this.speaking = false;
        this.pendingResolve = null;
        audio.onplaying = null;
        audio.onended = null;
        audio.onerror = null;
        this.revokeCurrentUrl();
        reject(new Error("TTS playback watchdog timeout"));
      }, PLAYBACK_START_TIMEOUT_MS);

      // "playing" fires when the browser actually has audible frames
      // ready to render — NOT "play" (fires as soon as .play() lifts
      // the element out of paused state, which can happen before enough
      // of a freshly-fetched MP3 blob is decoded) and NOT
      // "canplay"/"loadeddata" (fire even earlier, before playback has
      // been requested at all). The avatar's mouth animation is gated on
      // this "start" event (see orchestrator's constructor) specifically
      // so it can never start moving before sound is actually audible.
      audio.onplaying = () => {
        console.log("[TTS] playing disparou");
        window.clearTimeout(startWatchdog);
        this.speaking = true;
        this.emit("start");
      };
      audio.onended = () => {
        this.speaking = false;
        this.emit("end");
        this.revokeCurrentUrl();
        finish();
      };
      audio.onerror = (event) => {
        console.error("[TTS] erro audio:", event);
        this.speaking = false;
        this.emit("error", event);
        this.revokeCurrentUrl();
        finish();
      };
      void audio.play().catch((err) => {
        this.emit("error", err);
        finish();
      });
    });
  }

  cancel(): void {
    if (this.audio) {
      // Detach handlers first — an abandoned <audio> element must never
      // fire "playing"/"ended"/"error" against a blob URL cancel() is
      // about to revoke out from under it.
      this.audio.onplaying = null;
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio.currentTime = 0;
    }
    this.revokeCurrentUrl();
    this.speaking = false;
    // Settle any speakAtSpeed() call still awaiting "ended"/"error" — a
    // paused, abandoned element will never fire either, so without this
    // the caller (e.g. orchestrator.handleUserMessage) would hang forever.
    if (this.pendingResolve) {
      const finish = this.pendingResolve;
      this.pendingResolve = null;
      finish();
    }
  }

  private revokeCurrentUrl(): void {
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  on(event: SpeechEvent, cb: Listener): () => void {
    this.listeners[event].add(cb);
    return () => this.listeners[event].delete(cb);
  }

  /** Real <audio> element playing the current utterance. */
  getAudioElement(): HTMLAudioElement | null {
    return this.audio;
  }

  private emit(event: SpeechEvent, payload?: unknown): void {
    for (const cb of this.listeners[event]) cb(payload);
  }
}
