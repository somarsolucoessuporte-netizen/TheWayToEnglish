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
      {/* SVG, not a text glyph: "❚❚" has no glyph in many phone fonts and
          rendered as a lone square. */}
      <svg className="pause-btn-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        {paused ? (
          <path d="M4 2.5v11l9.5-5.5z" fill="currentColor" />
        ) : (
          <>
            <rect x="3" y="2.5" width="3.5" height="11" rx="1" fill="currentColor" />
            <rect x="9.5" y="2.5" width="3.5" height="11" rx="1" fill="currentColor" />
          </>
        )}
      </svg>
      <span className="pause-btn-label">{paused ? branding.copy.resumeButton : branding.copy.pauseButton}</span>
    </button>
  );
}
