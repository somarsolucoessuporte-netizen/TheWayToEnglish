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
/** Same guarantee as PLAYBACK_START_TIMEOUT_MS, for fallbackSpeak: browser
 * speechSynthesis is known to sometimes never fire onstart/onend/onerror
 * for a given utterance (notably Safari/iOS, or before its voice list has
 * finished loading) — without this, a student whose PRIMARY /api/tts call
 * failed for any reason (a transient network blip, an OpenAI TTS error)
 * would fall into a fallback call that itself never settles, leaving
 * runTurn's `finally` (busy = false) unreachable — the exact "digitou/
 * ouviu a fala mas a sessão trava, o botão Falar não responde mais"
 * production report. */
const FALLBACK_SPEECH_TIMEOUT_MS = 8000;

/** Upper bound on how long playBlob waits for the previous play() on the
 * shared element to settle before swapping .src — see waitForPendingPlay.
 * In practice pause() settles it within a tick; this only exists so a
 * browser that never settles it can't wedge speech. */
const PENDING_PLAY_SETTLE_MAX_MS = 1000;

/** Tiny silent MP3 played (and immediately paused) on the shared element
 * inside a real user gesture — see unlockAudioElement. */
const SILENT_MP3 =
  "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8fgCUpsYSCBFQkoiawwkAU3Lt1KwCMFHZEYEGxQGQtQkBMEyfZo0bwQOFDiw/JylTln4flJSt8/9e+zl63znSpe6cp913//1q3sk0VKAFoAYJDgBm2RwYBtThe";

/**
 * Speaks by requesting audio from /api/tts (a server route that holds the
 * OPENAI_API_KEY secret and calls OpenAI's /v1/audio/speech) and playing
 * the returned MP3 through a real <audio> element.
 */
export class OpenAITTSProvider implements SpeechProvider {
  /** The ONE <audio> element every playBlob() call plays through, for the
   * whole page lifetime. iOS Safari grants "may play with sound" per
   * ELEMENT, and only to an element that played inside a real user gesture
   * (see unlockAudioElement) — a `new Audio()` created later, on a turn
   * with no gesture behind it (every turn after the kickoff: the Falar
   * click is long gone by the time /api/chat + /api/tts come back), has
   * its play() rejected with NotAllowedError. That is exactly what
   * cd4e323 (a fresh element per call) caused: turn 1 spoke, every later
   * turn only showed text, for the rest of the session. The AbortError
   * that commit was trying to avoid only happens when .src is swapped
   * while a previous play() is still pending — impossible here, since
   * every call is serialized through the orchestrator's speech queue and
   * playBlob fully stops the previous playback first; a genuine AbortError
   * still gets one retry (see playBlob). Created lazily (SSR has no Audio). */
  private audioEl: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;
  private speaking = false;
  /** True while fallbackSpeak (browser speechSynthesis) is the one talking
   * — getAudioElement() then returns null, since the shared element's
   * `.duration` still belongs to the previous clip. */
  private usingFallback = false;
  /** Resolver for the in-flight playBlob() promise, if any — cancel()
   * calls this so an interruption (the Falar button, orchestrator.reset(),
   * a queue watchdog) can't leave a previous speak() call awaiting forever
   * on an "ended" event that a paused element will never fire. */
  private pendingResolve: (() => void) | null = null;
  /** Bumped by every cancel() — a speakAtSpeed() call that sees it change
   * across one of its awaits was cancelled mid-flight (mid-fetch, usually)
   * and must stop there: no playback, no fallback, just resolve. */
  private cancelGeneration = 0;
  /** The in-flight /api/tts fetch, so cancel() can abort it outright
   * instead of letting it finish and play over whatever came next. */
  private fetchController: AbortController | null = null;
  private fadeTimer: ReturnType<typeof setInterval> | null = null;
  /** The most recent play() on the shared element, mapped to always
   * resolve (never reject) — and true until it has. Assigning .src while a
   * play() is still pending is precisely what makes the browser reject it
   * with AbortError, so playBlob never touches .src before this settles. */
  private lastPlay: Promise<void> = Promise.resolve();
  private playPending = false;
  /** True while playBlob is between "stopped the previous clip" and
   * "started the new one" — unlockAudioElement must not slip a silent
   * clip onto the element in that window. */
  private preparingPlayback = false;
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
    // Re-unlocks on EVERY gesture, not just the first: cheap, and it means
    // the shared element is re-blessed by each Falar tap too, not only by
    // the lesson pick. Skipped while something is actually playing — see
    // unlockAudioElement.
    const unlock = () => this.unlockAudioElement();
    document.addEventListener("click", unlock, true);
    document.addEventListener("touchend", unlock, true);
  }

  private getAudioEl(): HTMLAudioElement {
    if (!this.audioEl) this.audioEl = new Audio();
    return this.audioEl;
  }

  /** Standard iOS Safari unlock trick: play (and immediately pause) a
   * silent clip on the SHARED element, synchronously inside a real user
   * gesture (see the constructor's click/touchend listener). Safari then
   * lets this specific element play with sound afterward, whatever .src
   * it's given — which is why playBlob reuses it instead of creating a new
   * one per call. Public so a caller with its own gesture handler can
   * call it directly too. */
  unlockAudioElement(): void {
    // Never clobber real speech, a clip about to start, or an unlock
    // that's still in flight (a double tap) — the latter would itself be a
    // .src swap over a pending play().
    if (this.speaking || this.pendingResolve || this.preparingPlayback || this.playPending) return;
    const el = this.getAudioEl();
    el.src = SILENT_MP3;
    // The pause() lives INSIDE the tracked promise (see trackPlay), and
    // only if the element still holds the silent clip: an unlock's pause
    // must never land on a real clip that started after it.
    this.trackPlay(el.play(), () => {
      if (el.src === SILENT_MP3) el.pause();
    }).catch(() => {});
  }

  /** Records `play` as the element's pending play() (see lastPlay) and
   * returns it unchanged for the caller to handle. `onResolved` runs
   * BEFORE lastPlay settles, so anything waiting on lastPlay also waits
   * for it. */
  private trackPlay(play: Promise<void>, onResolved?: () => void): Promise<void> {
    this.playPending = true;
    this.lastPlay = play.then(
      () => {
        onResolved?.();
        this.playPending = false;
      },
      () => {
        this.playPending = false;
      }
    );
    return play;
  }

  /** Waits (bounded) for the shared element's last play() to settle — see
   * lastPlay. The caller has already paused the element, which per the
   * HTML spec rejects a pending play() promptly; the bound is only for a
   * browser that doesn't. */
  private async waitForPendingPlay(): Promise<void> {
    if (!this.playPending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      this.lastPlay.then(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), PENDING_PLAY_SETTLE_MAX_MS);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) console.warn("[TTS] play() anterior não assentou a tempo — seguindo mesmo assim");
  }

  async speak(text: string, opts: SpeechOptions = {}): Promise<void> {
    return this.speakAtSpeed(text, 1.0, opts.lang);
  }

  /** See SpeechProvider.speakSlow. */
  async speakSlow(text: string, opts: SpeechOptions = {}): Promise<void> {
    return this.speakAtSpeed(text, SLOW_SPEED, opts.lang);
  }

  private async speakAtSpeed(text: string, speed: number, lang?: string): Promise<void> {
    const generation = this.cancelGeneration;
    const cancelled = () => generation !== this.cancelGeneration;
    try {
      console.log("[TTS] iniciando...");
      const controller = new AbortController();
      this.fetchController = controller;
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
        if (cancelled()) return;
        if ((fetchErr as Error).name === "AbortError") {
          throw new Error("TTS timeout: /api/tts não respondeu a tempo");
        }
        throw fetchErr;
      } finally {
        window.clearTimeout(timeoutId);
        if (this.fetchController === controller) this.fetchController = null;
      }
      if (cancelled()) return;
      console.log("[TTS] status:", response.status);
      if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);

      const arrayBuffer = await response.arrayBuffer();
      if (cancelled()) return;
      console.log("[TTS] blob size:", arrayBuffer.byteLength);
      await this.playBlob(new Blob([arrayBuffer], { type: "audio/mpeg" }));
    } catch (err) {
      // Cancelled while failing (e.g. the student pressed Falar mid-fetch):
      // nothing to fall back to — the interruption was the point.
      if (cancelled()) return;
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
        if (cancelled()) return;
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
      let settled = false;
      const settle = () => {
        settled = true;
        window.clearTimeout(timer);
        this.usingFallback = false;
        this.speaking = false;
        if (this.pendingResolve === finish) this.pendingResolve = null;
      };
      // cancel() (see its doc comment) resolves whatever's pending — the
      // fallback registers itself the same way playBlob does so an
      // interruption stops the robot voice too, not only the MP3 path.
      const finish = () => {
        if (settled) return;
        settle();
        window.speechSynthesis.cancel();
        resolve();
      };
      this.pendingResolve = finish;
      this.usingFallback = true;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settle();
        console.error(
          `[TTS] fallback watchdog: speechSynthesis não disparou onstart/onend/onerror em ${FALLBACK_SPEECH_TIMEOUT_MS}ms — cancelando`
        );
        window.speechSynthesis.cancel();
        reject(new Error("speechSynthesis fallback timeout"));
      }, FALLBACK_SPEECH_TIMEOUT_MS);
      u.onstart = () => {
        if (settled) return;
        // Once it's genuinely talking, the "never started" watchdog has
        // done its job — a long sentence must not be cut at 8s.
        window.clearTimeout(timer);
        this.speaking = true;
        this.emit("start");
      };
      u.onend = () => {
        if (settled) return;
        settle();
        this.emit("end");
        resolve();
      };
      u.onerror = (e) => {
        if (settled) return;
        settle();
        reject(e);
      };
      window.speechSynthesis.speak(u);
    });
  }

  /** See SpeechProvider.speakBlob — plays an already-fetched MP3 blob
   * (e.g. from a boot-time greeting prefetch) with no network round trip. */
  async speakBlob(blob: Blob): Promise<void> {
    try {
      console.log("[TTS] tocando blob pré-carregado");
      await this.playBlob(blob);
    } catch (err) {
      console.error("[OpenAI TTS] erro (blob pré-carregado):", err);
      this.emit("error", err);
      throw err;
    }
  }

  /** Shared by speakAtSpeed (fresh /api/tts fetch) and speakBlob (already
   * have the audio) — everything from "here's a Blob" onward is identical
   * either way. Plays through the shared, gesture-unlocked element (see
   * audioEl's doc comment). EVERY path out of the inner promise settles
   * it exactly once: onended/onerror/cancel() resolve, the start watchdog
   * and a (non-retried) play() rejection reject — there is no exit that
   * leaves it pending. */
  private async playBlob(blob: Blob): Promise<void> {
    const generation = this.cancelGeneration;
    this.stopPlayback(); // pause() first…
    this.preparingPlayback = true;
    try {
      await this.waitForPendingPlay(); // …then let the old play() settle before touching .src
    } finally {
      this.preparingPlayback = false;
    }
    if (generation !== this.cancelGeneration) return; // cancelled while waiting
    const url = URL.createObjectURL(blob);
    const audio = this.getAudioEl();
    audio.volume = 1;
    audio.src = url;
    this.currentUrl = url;
    console.log("[TTS] tocando no elemento compartilhado:", url);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const detach = () => {
        window.clearTimeout(startWatchdog);
        audio.onplaying = null;
        audio.onended = null;
        audio.onerror = null;
        if (this.pendingResolve === finish) this.pendingResolve = null;
      };
      // Wrapping resolve so cancel() can also settle this promise (and
      // clear the ref) if it interrupts before "ended"/"error" ever fire.
      const finish = () => {
        if (settled) return;
        settled = true;
        detach();
        resolve();
      };
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        detach();
        this.speaking = false;
        this.revokeCurrentUrl();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      this.pendingResolve = finish;

      // Watchdog for the case where audio.play() resolved (autoplay was
      // permitted) but "playing" never actually fires — a stalled decode,
      // or (notably on iOS Safari) the autoplay policy silently blocking
      // playback even though .play() itself didn't reject. REJECTS (not
      // resolves) so speakAtSpeed's catch can fall back to speechSynthesis.
      const startWatchdog = window.setTimeout(() => {
        console.error("[TTS] watchdog: 'playing' não disparou em", PLAYBACK_START_TIMEOUT_MS, "ms");
        audio.pause();
        fail(new Error("TTS playback watchdog timeout"));
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

      // A rejected play() REJECTS this promise (never resolves it as if
      // playback had worked — see a1f77b5) so speakAtSpeed's fallback runs.
      // AbortError ("a load/pause interrupted this play()") shouldn't
      // happen any more — waitForPendingPlay removed its cause — but if a
      // stray one does, retry once on the same src before treating it as a
      // real failure. Success is still only ever "playing" firing (the
      // start watchdog stays armed), never the play() promise alone.
      const tryPlay = (attempt: number) => {
        this.trackPlay(audio.play()).catch((err: unknown) => {
          if (settled) return;
          const name = (err as Error)?.name;
          if (name === "AbortError" && attempt === 0 && audio.src === url) {
            console.warn("[TTS] audio.play() AbortError — tentando de novo uma vez");
            tryPlay(1);
            return;
          }
          console.error("[TTS] audio.play() rejeitado:", err);
          this.emit("error", err);
          fail(err);
        });
      };
      tryPlay(0);
    });
  }

  /** Stops whatever the shared element is playing and settles its pending
   * promise — WITHOUT touching cancelGeneration, so playBlob can call it
   * on itself at the start of a new clip. */
  private stopPlayback(): void {
    if (this.fadeTimer !== null) {
      clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }
    const audio = this.audioEl;
    if (audio) {
      // Detach handlers first — a stopped element must never fire
      // "playing"/"ended"/"error" against a blob URL about to be revoked.
      audio.onplaying = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.volume = 1;
    }
    this.revokeCurrentUrl();
    this.speaking = false;
    if (this.pendingResolve) {
      const finish = this.pendingResolve;
      this.pendingResolve = null;
      finish();
    }
  }

  /**
   * Stops speech right now — aborts an in-flight /api/tts fetch (so it
   * can't finish later and start talking over whatever comes next),
   * cancels a speechSynthesis fallback, and settles the pending speak()
   * promise so the orchestrator's queue moves on. `fadeMs` (the Falar
   * interruption uses 120) ramps the volume down instead of a hard cut;
   * the promise still settles immediately, only the audible tail fades.
   * (iOS ignores `audio.volume`, so there it is simply a 120ms-later cut.)
   */
  cancel(fadeMs = 0): void {
    this.cancelGeneration++;
    this.fetchController?.abort();
    this.fetchController = null;
    if (this.usingFallback && typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    const audio = this.audioEl;
    if (fadeMs > 0 && audio && !audio.paused) {
      // Settle + detach now; only the sound itself lingers for fadeMs.
      audio.onplaying = null;
      audio.onended = null;
      audio.onerror = null;
      this.speaking = false;
      if (this.pendingResolve) {
        const finish = this.pendingResolve;
        this.pendingResolve = null;
        finish();
      }
      const steps = 6;
      const startVolume = audio.volume;
      let step = 0;
      if (this.fadeTimer !== null) clearInterval(this.fadeTimer);
      this.fadeTimer = setInterval(() => {
        step++;
        audio.volume = Math.max(0, startVolume * (1 - step / steps));
        if (step >= steps) this.stopPlayback();
      }, fadeMs / steps);
      return;
    }
    this.stopPlayback();
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

  /** Real <audio> element playing the current utterance (null while the
   * speechSynthesis fallback is the one talking — see usingFallback). */
  getAudioElement(): HTMLAudioElement | null {
    return this.usingFallback ? null : this.audioEl;
  }

  private emit(event: SpeechEvent, payload?: unknown): void {
    for (const cb of this.listeners[event]) cb(payload);
  }
}
