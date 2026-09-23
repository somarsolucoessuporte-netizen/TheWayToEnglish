import { branding } from "@/app-config/branding";

/**
 * Sits next to the Falar button, always visible and always enabled while a
 * lesson is running — the student's way out of anything (a repeat loop, a
 * reply they don't want to hear out, an open mic). See orchestrator.pause()
 * / resume() for what each state actually does; this is only the toggle.
 */
export function PauseButton({ paused, onToggle }: { paused: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`btn pause-btn${paused ? " pause-btn--paused" : ""}`}
      onClick={onToggle}
      aria-pressed={paused}
      aria-label={paused ? branding.copy.resumeButton : branding.copy.pauseButton}
    >
      <span className="pause-btn-icon" aria-hidden="true">
        {paused ? "▶" : "❚❚"}
      </span>
      <span className="pause-btn-label">{paused ? branding.copy.resumeButton : branding.copy.pauseButton}</span>
    </button>
  );
}
