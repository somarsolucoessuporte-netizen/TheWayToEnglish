/** Only ids shaped like curriculum's taskId() get into the prompt — this
 * arrives from the client, so anything else is dropped. */
const TASK_ID_RE = /^task-\d+$/;

/**
 * The system note /api/chat adds after the lesson plan: which tasks the
 * orchestrator has recorded as done and which one is current. The plan
 * tells the model to skip tasks it "already reported in completedGoals",
 * but the history it receives is plain speech text — this note is the
 * only place it can actually see that. undefined when there's nothing to
 * say (no progress info sent, e.g. the lesson kickoff prefetch).
 */
export function buildLessonProgressNote(completedGoals: unknown, currentTaskId: unknown): string | undefined {
  const done = Array.isArray(completedGoals)
    ? completedGoals.filter((g): g is string => typeof g === "string" && TASK_ID_RE.test(g))
    : [];
  const current = typeof currentTaskId === "string" && TASK_ID_RE.test(currentTaskId) ? currentTaskId : undefined;
  if (done.length === 0 && !current) return undefined;
  return (
    "LESSON PROGRESS (tracked by the app — authoritative, overrides your own reading of the conversation): " +
    `Tasks already completed: ${done.length > 0 ? done.join(", ") : "none"}. ` +
    (current ? `Current task: ${current}. ` : "") +
    "Do not repeat completed tasks."
  );
}
