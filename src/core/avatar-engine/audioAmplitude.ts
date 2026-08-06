export interface AmplitudeSource {
  /** returns a normalized loudness estimate in [0,1] */
  sample(): number;
  stop(): void;
}

/**
 * Real amplitude from an <audio> element via Web Audio's AnalyserNode.
 * createMediaElementSource may only be called once per element for its
 * whole lifetime, so callers must cache/reuse the result per element.
 */
export function createAnalyserAmplitudeSource(audio: HTMLAudioElement): AmplitudeSource {
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  const source = ctx.createMediaElementSource(audio);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);
  analyser.connect(ctx.destination);

  const data = new Uint8Array(analyser.frequencyBinCount);

  return {
    sample() {
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      return Math.min(1, rms * 4);
    },
    stop() {
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        // already disconnected
      }
      void ctx.close().catch(() => {});
    },
  };
}

/**
 * Fallback for providers that expose no <audio> element (the default
 * WebSpeechProvider uses the browser's speechSynthesis, which plays audio
 * outside any element we can analyze). Produces a natural, non-looping
 * open/close rhythm — the spec explicitly does not want phoneme-accurate
 * sync, just believable movement.
 */
export function createSyntheticAmplitudeSource(): AmplitudeSource {
  let t = 0;
  return {
    sample() {
      t += 1;
      const base = (Math.sin(t * 0.35) + 1) / 2;
      const wobble = (Math.sin(t * 0.9 + 1.3) + 1) / 2;
      const noise = Math.random() * 0.25;
      return Math.min(1, base * 0.5 + wobble * 0.3 + noise);
    },
    stop() {},
  };
}
