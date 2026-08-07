"use client";

import type { ChatEntry } from "@/core/conversation/orchestrator";

/** Mirrors the orchestrator's own updateGoalProgress dedup logic (see
 * ConversationOrchestrator) as a UI-side re-derivation from `entries`
 * (already exposed to every consumer of onEntriesChange) rather than a
 * new value read off the orchestrator itself — this bar is UI-only, no
 * orchestrator/business-logic changes. */
function countCompletedSteps(entries: ChatEntry[], canDoGoals: string[]): number {
  const completed = new Set<string>();
  for (const entry of entries) {
    if (entry.role !== "tutor") continue;
    for (const goal of entry.response.completedGoals ?? []) {
      if (canDoGoals.includes(goal)) completed.add(goal);
    }
  }
  return completed.size;
}

/**
 * Second, thinner progress strip under the lesson time bar (see
 * LessonTimer) — tracks how many of the current lesson's can-do goals
 * (app-config/curriculum's CurriculumLesson.canDo) have been demonstrated
 * so far. The curriculum has no separate numbered "step" concept (see
 * LessonCompleteCard's own earlier note on this) — can-do goals are the
 * closest real, already-tracked equivalent, and are exactly what already
 * decides when the lesson is complete (see orchestrator's
 * updateGoalProgress), so "etapa" here means "can-do goal demonstrated".
 * Renders nothing for a lesson with no can-do goals at all.
 */
export function LessonProgressBar({
  entries,
  canDoGoals,
}: {
  entries: ChatEntry[];
  canDoGoals: string[];
}) {
  const totalSteps = canDoGoals.length;
  if (totalSteps === 0) return null;
  const stepsCompleted = countCompletedSteps(entries, canDoGoals);
  const pct = Math.min(100, (stepsCompleted / totalSteps) * 100);

  return (
    <div className="lesson-progress">
      <div className="lesson-progress-track">
        <div className="lesson-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="lesson-progress-label">
        Etapa {stepsCompleted} de {totalSteps}
      </div>
    </div>
  );
}
