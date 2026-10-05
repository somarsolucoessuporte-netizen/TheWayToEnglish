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
}

export interface ExistingLesson {
  id: string;
  code: string;
  edited_fields: string[] | null;
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
    practice_note: lesson.practiceNote ?? null,
    legacy_tasks: lesson.tasks,
    requires_images: lesson.requiresImages,
    image_note: lesson.imageNote ?? null,
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
    plan.updates.push({ id: current.id, code: lesson.code, values: kept, protectedFields });
  }

  const docxCodes = new Set(fromDocx.map((l) => l.code));
  plan.missingFromDocx = existing.filter((l) => !docxCodes.has(l.code)).map((l) => l.code);
  return plan;
}
