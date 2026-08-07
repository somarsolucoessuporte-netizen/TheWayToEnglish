/**
 * Short three-note ascending "ding" (C5–E5–G5, a C major chord broken
 * upward) played via the Web Audio API — no external asset, so it works in
 * any environment. Fired right when praise is triggered, before the
 * tutor's spoken praise begins (see orchestrator.handleUserMessage).
 */
export function playCorrectSound(): void {
  if (typeof window === "undefined") return;
  const AudioContextCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;

  const ctx = new AudioContextCtor();

  const playTone = (freq: number, startTime: number, duration: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.25, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.start(startTime);
    osc.stop(startTime + duration);
  };

  const now = ctx.currentTime;
  playTone(523, now, 0.12); // C5
  playTone(659, now + 0.13, 0.15); // E5
  playTone(784, now + 0.28, 0.2); // G5

  // Release the context once the chord has finished — leaving it open
  // would leak one AudioContext per praise turn.
  window.setTimeout(() => void ctx.close(), 600);
}
