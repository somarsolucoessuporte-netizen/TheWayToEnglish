// Pure merge between the lessons a fresh .docx produced (processar-unit.py's
// JSON) and the lessons already in Supabase for that unit. No I/O here, so
// scripts/test-admin-merge.cjs can check the protection rules directly.
//
// Rules:
// - new lesson code       → inserted, status 'pendente'
// - existing lesson       → every docx-derived column is overwritten EXCEPT
//                           the ones listed in its edited_fields (corrected
//                           by hand in /admin); status is never touched
// - lesson only in the DB → left alone and reported, never deleted
// - task images           → a task's imagePath (set by /admin's per-task
//                           upload, it exists only in the database) is carried
//                           over to the docx task with the same order
// - item images           → come from the .docx itself (processar-unit.py
//                           --images); hand edits to items (text, picture,
//                           "Usar imagem") protect legacy_tasks as a whole

/** The lesson columns a .docx import writes. */
export const DOCX_LESSON_FIELDS = [
  "title",
  "skill",
  "order",
  "reference_content",
  "practice_note",
  "legacy_tasks",
  "requires_images",
  "image_note",
  "source_excerpt",
] as const;

export type DocxLessonField = (typeof DOCX_LESSON_FIELDS)[number];
export type DocxLessonValues = Record<DocxLessonField, unknown>;

/** One lesson as processar-unit.py writes it. */
export interface DocxLesson {
  code: string;
  title: string | null;
  skill: string | null;
  order: number;
  practiceNote?: string;
  tasks: unknown[];
  referenceContent: unknown;
  requiresImages: boolean;
  imageNote?: string;
  /** "Sem tarefa oral nessa lição" — the school's own red note. */
  noTasksNote?: string;
  /** The lesson's text as in the .docx, red lines marked. */
  sourceExcerpt?: string;
}

export interface ExistingLesson {
  id: string;
  code: string;
  edited_fields: string[] | null;
  legacy_tasks?: unknown;
}

type TaskLike = { order?: unknown; imagePath?: unknown } & Record<string, unknown>;

function asTasks(value: unknown): TaskLike[] {
  return Array.isArray(value) ? (value.filter((t) => t && typeof t === "object") as TaskLike[]) : [];
}

/** `tasks` with each task's imagePath taken from the `previous` task of the
 * same order (when it had one). Anything else about `tasks` wins. */
export function carryImagePaths(tasks: unknown, previous: unknown): unknown {
  if (!Array.isArray(tasks)) return tasks;
  const paths = new Map(
    asTasks(previous)
      .filter((t) => typeof t.imagePath === "string")
      .map((t) => [t.order, t.imagePath as string])
  );
  return tasks.map((task) => {
    if (!task || typeof task !== "object") return task;
    const { imagePath: _ignored, ...rest } = task as TaskLike;
    const path = paths.get(rest.order);
    return path ? { ...rest, imagePath: path } : rest;
  });
}

/** Tasks without imagePath — what /admin's JSON editor shows (image paths
 * are only changed by the per-task upload). */
export function stripImagePaths(tasks: unknown): unknown {
  if (!Array.isArray(tasks)) return tasks;
  return tasks.map((task) => {
    if (!task || typeof task !== "object") return task;
    const { imagePath: _ignored, ...rest } = task as TaskLike;
    return rest;
  });
}

export interface LessonMergePlan {
  inserts: (DocxLessonValues & { code: string; status: "pendente" })[];
  updates: { id: string; code: string; values: Partial<DocxLessonValues>; protectedFields: DocxLessonField[] }[];
  /** In the database, absent from this .docx — untouched. */
  missingFromDocx: string[];
}

export function docxLessonValues(lesson: DocxLesson): DocxLessonValues {
  return {
    title: lesson.title,
    skill: lesson.skill,
    order: lesson.order,
    reference_content: lesson.referenceContent,
    // The "no task" note is red text too: it reaches the tutor with the
    // practice note.
    practice_note: [lesson.practiceNote, lesson.noTasksNote].filter(Boolean).join("\n") || null,
    legacy_tasks: lesson.tasks,
    requires_images: lesson.requiresImages,
    image_note: lesson.imageNote ?? null,
    source_excerpt: lesson.sourceExcerpt ?? null,
  };
}

export function planLessonMerge(existing: ExistingLesson[], fromDocx: DocxLesson[]): LessonMergePlan {
  const byCode = new Map(existing.map((l) => [l.code, l]));
  const plan: LessonMergePlan = { inserts: [], updates: [], missingFromDocx: [] };

  for (const lesson of fromDocx) {
    const values = docxLessonValues(lesson);
    const current = byCode.get(lesson.code);
    if (!current) {
      plan.inserts.push({ ...values, code: lesson.code, status: "pendente" });
      continue;
    }
    const edited = new Set(current.edited_fields ?? []);
    const protectedFields = DOCX_LESSON_FIELDS.filter((f) => edited.has(f));
    const kept = Object.fromEntries(
      DOCX_LESSON_FIELDS.filter((f) => !edited.has(f)).map((f) => [f, values[f]])
    ) as Partial<DocxLessonValues>;
    if ("legacy_tasks" in kept) kept.legacy_tasks = carryImagePaths(kept.legacy_tasks, current.legacy_tasks);
    plan.updates.push({ id: current.id, code: lesson.code, values: kept, protectedFields });
  }

  const docxCodes = new Set(fromDocx.map((l) => l.code));
  plan.missingFromDocx = existing.filter((l) => !docxCodes.has(l.code)).map((l) => l.code);
  return plan;
}

// ------------------------------------------------- school adjustments --

/** src/app-config/curriculum/ajustes-escola.json, for one unit: marks laid
 * over what the .docx says — never a correction of the school's text.
 * schoolCheck = "verificar com a escola" in /admin; disabled = the task is
 * off until a decision (the tutor skips it). */
export interface UnitAdjustments {
  [lessonCode: string]: {
    schoolChecks?: string[];
    tasks?: {
      order: number;
      disabled?: string;
      schoolCheck?: string;
      items?: { match: string; schoolCheck: string }[];
    }[];
  };
}

type ItemLike = { prompt?: unknown; expectedAnswer?: unknown; schoolCheck?: unknown } & Record<string, unknown>;

/** Applies the adjustments to the lessons read from a .docx (in place) and
 * returns what could not be found — a lesson, task or item the .docx no
 * longer has — so the caller reports it instead of failing silently. */
export function applySchoolAdjustments(lessons: DocxLesson[], adjustments: UnitAdjustments | undefined): string[] {
  const missing: string[] = [];
  for (const [code, adjust] of Object.entries(adjustments ?? {})) {
    const lesson = lessons.find((l) => l.code === code);
    if (!lesson) {
      missing.push(`${code}: lição não encontrada`);
      continue;
    }
    if (adjust.schoolChecks?.length) {
      const reference = (lesson.referenceContent && typeof lesson.referenceContent === "object" ? lesson.referenceContent : {}) as Record<string, unknown>;
      lesson.referenceContent = { ...reference, schoolChecks: adjust.schoolChecks };
    }
    for (const taskAdjust of adjust.tasks ?? []) {
      const task = asTasks(lesson.tasks).find((t) => t.order === taskAdjust.order);
      if (!task) {
        missing.push(`${code} task-${taskAdjust.order}: task não encontrada`);
        continue;
      }
      if (taskAdjust.disabled) {
        task.disabled = true;
        task.disabledReason = taskAdjust.disabled;
      }
      if (taskAdjust.schoolCheck) task.schoolCheck = taskAdjust.schoolCheck;
      const items = (Array.isArray(task.items) ? task.items : []) as ItemLike[];
      for (const itemAdjust of taskAdjust.items ?? []) {
        const needle = itemAdjust.match.toLowerCase();
        const item = items.find((i) => `${i.prompt ?? ""}\n${i.expectedAnswer ?? ""}`.toLowerCase().includes(needle));
        if (item) item.schoolCheck = itemAdjust.schoolCheck;
        else missing.push(`${code} task-${taskAdjust.order}: item "${itemAdjust.match}" não encontrado`);
      }
    }
  }
  return missing;
}
