import { branding } from "@/app-config/branding";

/** RMS the bars treat as "fully loud" (scaleY 1) — WhisperSTTProvider's
 * silence threshold is 0.015, normal speech typically lands well above
 * that, so this gives a wide, expressive range without needing to shout. */
const AMPLITUDE_REFERENCE = 0.18;
/** Bars never fully flatten even at true silence — matches the old fixed
 * animation's 0.4 floor closely enough while reading as "winding down"
 * (see the class doc comment on the auto-stop VAD) as amplitude drops. */
const MIN_SCALE = 0.25;
/** Per-bar multiplier, same visual "V" proportions the old fixed-height
 * bars had (8/16/24/16/8px) — keeps the center bar the tallest so real
 * amplitude still reads as an equalizer, not five identical sticks. */
const BAR_MULTIPLIERS = [0.33, 0.67, 1, 0.67, 0.33];

/**
 * Push-to-talk button — the ONLY place in the app that opens the
 * microphone (onClick -> orchestrator.startListening()). Dual-purpose:
 * opens the mic when idle, or force-sends the current utterance right now
 * when already listening — instead of waiting for the STT provider's own
 * silence-based auto-stop (VAD, see WhisperSTTProvider). Useful in noisy
 * rooms, or when the student just wants to move on faster.
 *
 * The single essential action on this screen — solid primary treatment
 * (not the ghost/outline style everything else uses), with three visually
 * distinct states the CSS keys off `force-send-btn--listening` /
 * `force-send-btn--processing` modifier classes for (see globals.css):
 *   idle       — solid, slow attention pulse (off under
 *                prefers-reduced-motion), label "Falar".
 *   listening  — active green, real mic-amplitude sound-wave bars (see
 *                `amplitude` — 0 for an STT provider without a real VAD,
 *                which just renders flat bars), label swaps to
 *                `listeningLabel`.
 *   processing — disabled, spinner + "Um instante…" while a batch STT
 *                provider is uploading/transcribing (see
 *                orchestrator.onTranscribing) — can't be force-sent again
 *                mid-upload, so the click handler is blocked here too,
 *                not just visually.
 */
export function ForceSendButton({
  label,
  listeningLabel,
  isListening,
  processing = false,
  onClick,
  amplitude = 0,
}: {
  label: string;
  listeningLabel: string;
  isListening: boolean;
  processing?: boolean;
  onClick: () => void;
  amplitude?: number;
}) {
  const amplitudeNorm = Math.min(1, Math.max(0, amplitude) / AMPLITUDE_REFERENCE);
  const scale = MIN_SCALE + amplitudeNorm * (1 - MIN_SCALE);

  const stateClass = processing ? " force-send-btn--processing" : isListening ? " force-send-btn--listening" : "";

  return (
    <button
      type="button"
      className={`btn force-send-btn${stateClass}`}
      onClick={onClick}
      disabled={processing}
    >
      {processing ? (
        <span className="listening-indicator">
          <span className="force-send-spinner" aria-hidden="true" />
          <span className="listening-label">{branding.copy.forceSendProcessing}</span>
        </span>
      ) : isListening ? (
        <span className="listening-indicator">
          <span className="sound-wave">
            {BAR_MULTIPLIERS.map((multiplier, i) => (
              <span key={i} style={{ transform: `scaleY(${scale * multiplier})` }} />
            ))}
          </span>
          <span className="listening-label">{listeningLabel}</span>
        </span>
      ) : (
        label
      )}
    </button>
  );
}
