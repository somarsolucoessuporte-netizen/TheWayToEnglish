import { useEffect, useRef, useState } from "react";
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
/** Held this long without releasing triggers the escape-hatch reset (see
 * onLongPress) instead of the normal click action. */
const LONG_PRESS_MS = 1500;

/**
 * Push-to-talk button — the ONLY place in the app that opens the
 * microphone (onClick -> orchestrator.startListening()). Dual-purpose:
 * opens the mic when idle, or force-sends the current utterance right now
 * when already listening — instead of waiting for the STT provider's own
 * silence-based auto-stop (VAD, see WhisperSTTProvider). Useful in noisy
 * rooms, or when the student just wants to move on faster.
 *
 * The single essential action on this screen — with three visually
 * distinct states the CSS keys off `force-send-btn--listening` /
 * `force-send-btn--processing` modifier classes for (see globals.css):
 *   idle       — frosted glass, slow border pulse (off under
 *                prefers-reduced-motion) signaling "sua vez".
 *   listening  — red-tinted glass, real mic-amplitude sound-wave bars (see
 *                `amplitude` — 0 for an STT provider without a real VAD,
 *                which just renders flat bars), label swaps to
 *                `listeningLabel`.
 *   processing — disabled, spinner + "Um instante…" while a batch STT
 *                provider is uploading/transcribing (see
 *                orchestrator.onTranscribing) — can't be force-sent again
 *                mid-upload, so the click handler is blocked here too,
 *                not just visually.
 *
 * Two extra behaviors, both defensive UX for the case something hangs
 * (see orchestrator.startListening's return value / forceReset doc
 * comments):
 *   shakeTrigger — bump this number (page.tsx does, whenever a click was
 *                  silently ignored because the orchestrator is busy) to
 *                  play a brief shake, so "nothing happened" always LOOKS
 *                  like something happened instead of reading as a dead
 *                  button.
 *   onLongPress  — held for 1.5s, fires instead of the normal click and
 *                  suppresses it — wired to orchestrator.forceReset() as
 *                  a safety net the student can reach for themselves if
 *                  the button ever does genuinely get stuck.
 *
 * Two more, both purely visual (see globals.css's .force-send-btn-dock —
 * this button is now a single page-level floating instance, always
 * mounted while a lesson is running, never conditionally unmounted):
 *   hidden         — fades out and stops accepting clicks (opacity 0,
 *                    pointer-events none) instead of unmounting, so the
 *                    dock's layout never jumps — used while the tutor is
 *                    actively speaking, when force-sending makes no sense.
 *   awaitingRepeat — pulses the border for a few seconds right after the
 *                    "hear it, repeat it" drill's "Now you try." cue (see
 *                    orchestrator.onAwaitingRepeat), so the student
 *                    notices it's their turn.
 */
export function ForceSendButton({
  label,
  listeningLabel,
  isListening,
  processing = false,
  hidden = false,
  awaitingRepeat = false,
  onClick,
  onLongPress,
  amplitude = 0,
  shakeTrigger = 0,
}: {
  label: string;
  listeningLabel: string;
  isListening: boolean;
  processing?: boolean;
  hidden?: boolean;
  awaitingRepeat?: boolean;
  onClick: () => void;
  onLongPress?: () => void;
  amplitude?: number;
  shakeTrigger?: number;
}) {
  const amplitudeNorm = Math.min(1, Math.max(0, amplitude) / AMPLITUDE_REFERENCE);
  const scale = MIN_SCALE + amplitudeNorm * (1 - MIN_SCALE);

  const stateClass = processing ? " force-send-btn--processing" : isListening ? " force-send-btn--listening" : "";
  const hiddenClass = hidden ? " force-send-btn--hidden" : "";
  const awaitingRepeatClass = awaitingRepeat && !hidden ? " force-send-btn--awaiting-repeat" : "";

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  function clearLongPressTimer() {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function handlePointerDown() {
    if (!onLongPress) return;
    longPressFiredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      onLongPress();
    }, LONG_PRESS_MS);
  }

  function handlePointerUpOrLeave() {
    clearLongPressTimer();
  }

  function handleClick() {
    // The native click that follows pointerup after a long-press already
    // fired is swallowed here — the long-press already did its own thing
    // (forceReset), the short-press action must not ALSO run on release.
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    onClick();
  }

  useEffect(() => clearLongPressTimer, []); // unmount safety

  // Fires a brief shake whenever shakeTrigger changes (see this
  // component's doc comment) — a ref + local state instead of driving it
  // straight off the prop so the animation class actually re-triggers
  // even if shakeTrigger's value repeats (page.tsx just increments a
  // counter, so in practice it never repeats, but this is the robust
  // pattern regardless).
  const [shaking, setShaking] = useState(false);
  const isFirstShakeRender = useRef(true);
  useEffect(() => {
    if (isFirstShakeRender.current) {
      isFirstShakeRender.current = false;
      return;
    }
    setShaking(true);
    const t = setTimeout(() => setShaking(false), 400);
    return () => clearTimeout(t);
  }, [shakeTrigger]);

  return (
    <button
      type="button"
      className={`btn force-send-btn${stateClass}${hiddenClass}${awaitingRepeatClass}${shaking ? " force-send-btn--shake" : ""}`}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUpOrLeave}
      onPointerLeave={handlePointerUpOrLeave}
      onPointerCancel={handlePointerUpOrLeave}
      disabled={processing || hidden}
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
