/** Dual-purpose talk button for hands-free voice mode: starts listening
 * manually when idle/thinking (covers cases where the automatic VAD
 * relisten hasn't kicked in yet), or forces the current utterance to send
 * immediately when already listening — instead of waiting for VAD to
 * detect a silence gap. Useful in noisy rooms, or when the student just
 * wants to move on faster. While listening, the label is swapped for a
 * pulsing sound-wave equalizer so the button visibly confirms the mic is
 * live — the click behavior (force-send) is unchanged. */
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
