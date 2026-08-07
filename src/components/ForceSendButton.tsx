/** Push-to-talk button — the ONLY place in the app that opens the
 * microphone (onClick -> orchestrator.startListening()). Dual-purpose:
 * opens the mic when idle, or force-sends the current utterance right now
 * when already listening — instead of waiting for the STT provider's own
 * silence-based auto-stop (VAD). Useful in noisy rooms, or when the
 * student just wants to move on faster. While listening, the label is
 * swapped for a pulsing sound-wave equalizer so the button visibly
 * confirms the mic is live — the click behavior (force-send) is
 * unchanged. */
export function ForceSendButton({
  label,
  listeningLabel,
  isListening,
  onClick,
}: {
  label: string;
  listeningLabel: string;
  isListening: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="btn btn-ghost force-send-btn" onClick={onClick}>
      {isListening ? (
        <span className="listening-indicator">
          <span className="sound-wave">
            <span />
            <span />
            <span />
            <span />
            <span />
          </span>
          <span className="listening-label">{listeningLabel}</span>
        </span>
      ) : (
        label
      )}
    </button>
  );
}
