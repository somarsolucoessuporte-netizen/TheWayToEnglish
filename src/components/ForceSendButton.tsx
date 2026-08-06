import { branding } from "@/app-config/branding";

/** Manual fallback for hands-free voice mode (spec item 5): lets the
 * student force the current utterance to send immediately instead of
 * waiting for VAD to detect a silence gap — useful in noisy rooms, or
 * when they just want to move on faster. */
export function ForceSendButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn btn-ghost force-send-btn" onClick={onClick}>
      {branding.copy.forceSendButton}
    </button>
  );
}
