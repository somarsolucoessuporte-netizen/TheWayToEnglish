/** Dual-purpose talk button for hands-free voice mode: starts listening
 * manually when idle/thinking (covers cases where the automatic VAD
 * relisten hasn't kicked in yet), or forces the current utterance to send
 * immediately when already listening — instead of waiting for VAD to
 * detect a silence gap. Useful in noisy rooms, or when the student just
 * wants to move on faster. */
export function ForceSendButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-ghost force-send-btn" onClick={onClick}>
      {label}
    </button>
  );
}
