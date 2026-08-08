"use client";

const GREEN = "var(--success)";
const YELLOW = "var(--warn)";
const RED = "var(--error)";

function formatMMSS(totalSeconds: number): string {
  const clamped = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Fill grows left-to-right as the lesson elapses (not as time remains) —
 * the color bands are keyed to elapsed%, matching the spec's "first 70%
 * green, 70-90% yellow, last 10% red" as a description of the growing bar
 * itself. See page.tsx for the countdown that drives remainingSeconds
 * (paused outside "idle"/"listening" — see the timer effect there).
 */
export function LessonTimer({
  totalSeconds,
  remainingSeconds,
}: {
  totalSeconds: number;
  remainingSeconds: number;
}) {
  const elapsedPct =
    totalSeconds > 0 ? Math.min(100, Math.max(0, ((totalSeconds - remainingSeconds) / totalSeconds) * 100)) : 0;
  const color = elapsedPct >= 90 ? RED : elapsedPct >= 70 ? YELLOW : GREEN;

  return (
    <div className="lesson-timer">
      <div className="lesson-timer-track">
        <div className="lesson-timer-fill" style={{ width: `${elapsedPct}%`, background: color }} />
      </div>
      <div className="lesson-timer-time">{formatMMSS(remainingSeconds)} restantes</div>
    </div>
  );
}
