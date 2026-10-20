import { findLessonByRef, nextLessonAfter } from "./lookup";
import book01unit01 from "./book01-unit01.json";
import book01unit03 from "./book01-unit03.json";
import book01unit04 from "./book01-unit04.json";
import book01unit05 from "./book01-unit05.json";
import book02unit01 from "./book02-unit01.json";
import book02unit02 from "./book02-unit02.json";

// The curriculum as bundled JSON (one file per unit, written by
// scripts/carregar-material.cjs from the same processar-unit.py output it
// loads into Supabase), synchronous. Since the app moved to Supabase this is
// the FALLBACK source — see ./index.ts, which serves the app from Supabase
// and falls back to these same functions — and the shared definition of
// CurriculumLesson / buildCurriculumLesson that both sources build lessons
// with.

// ---- New-format shape (bookXX-unitXX.json) — the real curriculum data:
// a task-by-task script the tutor executes, plus reference material
// (dialogues/vocabulary/tables) it draws on while executing it. See
// app/api/chat/route.ts's buildLessonPlanBlock for how this is injected
// into the system prompt. ----

/**
 * How much a task depends on seeing an image — per TASK, not per lesson
 * (the old lesson-level `requiresImages` flagged 10 of 22 lessons whole,
 * including ones like B whose spoken practice works fine without any
 * picture). Set by scripts/processar-unit.py's classify_image_dependency.
 *   oral       — no image needed; runs as written.
 *   visual     — items with a picture show it on the student's screen;
 *                without one, the part that needs sight is dropped
 *                (people/things are named or described in words).
 *   image-only — nothing is left without the image: runs only when some
 *                item has a picture to show, otherwise skipped and kept
 *                out of the progress denominator (canDo).
 * Missing = "oral" (older unit JSON without the field).
 */
export type ImageDependency = "oral" | "visual" | "image-only";

/** One thing the tutor asks inside a task, in order: the cue/question, the
 * answer the school expects (null when the material gives none) and the
 * picture shown on the student's screen while it is asked. */
export interface CurriculumItem {
  label?: string;
  prompt: string;
  expectedAnswer: string | null;
  /** What the tutor says back when the student opens the exchange. */
  reply?: string;
  /** Path in the lesson-images bucket (<book>/<unit>/<lesson>/task-<n>-item-<m>.<ext>). */
  imagePath?: string;
  /** Other pictures from the same table cell, shown next to imagePath. */
  extraImagePaths?: string[];
  /** false = the picture stays stored but is not shown ("Usar imagem" in /admin). */
  useImage?: boolean;
  /** Something in the school's text to confirm with them — shown in /admin only. */
  schoolCheck?: string;
  /** The item came from the black reference text, not from a red table. */
  fromReference?: boolean;
  imageFloatingInCell?: boolean;
}

export interface CurriculumTask {
  order: number;
  instruction: string;
  type: string;
  imageDependency?: ImageDependency;
  items?: CurriculumItem[];
  /** The school wrote the items after "for example". */
  itemsAreExamples?: boolean;
  /** Turned off until a decision is made (the reason is shown in /admin): the
   * tutor skips it and it is not part of the progress denominator. */
  disabled?: boolean;
  disabledReason?: string;
  /** Something in the school's text to confirm with them — /admin only. */
  schoolCheck?: string;
  /** Legacy per-task picture (old /admin upload). */
  imagePath?: string;
}

/** Opaque, stable id for an item within a lesson — what the tutor echoes in
 * TutorResponse.item so the app knows which picture to show. */
export function itemId(order: number, index: number): string {
  return `task-${order}-item-${index + 1}`;
}

/** The storage paths shown on screen for this item of `task` ([] = no
 * picture): none when the item's or the whole task's "Usar imagem" is off
 * (the task's is its imageDependency — "oral" or missing = no picture). */
export function itemImagePaths(task: CurriculumTask, item: CurriculumItem): string[] {
  const taskUsesImages = task.imageDependency === "visual" || task.imageDependency === "image-only";
  if (!taskUsesImages || item.useImage === false || !item.imagePath) return [];
  return [item.imagePath, ...(item.extraImagePaths ?? [])];
}

export function taskShowsImages(task: CurriculumTask): boolean {
  return (task.items ?? []).some((item) => itemImagePaths(task, item).length > 0);
}

/** The tasks that can actually run in this app today — see ImageDependency
 * and CurriculumTask.disabled. */
export function playableTasks(tasks: CurriculumTask[]): CurriculumTask[] {
  return tasks.filter((t) => !t.disabled && (t.imageDependency !== "image-only" || taskShowsImages(t)));
}

export interface CurriculumTable {
  rows: string[][];
  caption?: string;
}

export interface CurriculumPracticePhraseGroup {
  group: string;
  phrases: string[];
}

export interface CurriculumReferenceContent {
  dialogues: string[][];
  vocabulary: string[];
  grammarNotes?: string[];
  tables?: CurriculumTable[];
  practicePhrases?: CurriculumPracticePhraseGroup[];
  /** Lesson-level things to confirm with the school — /admin only, never
   * sent to the tutor. */
  schoolChecks?: string[];
}

export interface CurriculumUnitData {
  book: string;
  unit: string;
  unitTheme?: string | null;
  globalPrinciples: string[];
  tutorIdentity?: { name: string; age: number; nationality: string; occupation: string };
  lessons: RawLessonPlan[];
}

export interface RawLessonPlan {
  code: string;
  title: string | null;
  skill: string | null;
  order: number;
  practiceNote?: string;
  tasks: CurriculumTask[];
  referenceContent: CurriculumReferenceContent;
  requiresImages: boolean;
  imageNote?: string;
}

/** A unit's global principles as stored (units.global_principles): the
 * school's own list, or — while only Book 1 / Unit 1 has one — a copy of it
 * marked as inherited, pending the school's answer. */
export type StoredPrinciples = string[] | { inheritedFrom: string; principles: string[] } | null;

export function principlesOf(stored: StoredPrinciples | undefined): { principles: string[]; inheritedFrom?: string } {
  if (Array.isArray(stored)) return { principles: stored };
  if (stored && Array.isArray(stored.principles)) return { principles: stored.principles, inheritedFrom: stored.inheritedFrom };
  return { principles: [] };
}

/** "Book 2" → "book02", "Unit 1" → "unit01" — the codes in books/units. */
export function codeFromLabel(prefix: "book" | "unit", label: string): string {
  const n = Number(String(label).match(/(\d+)/)?.[1]);
  return `${prefix}${String(n).padStart(2, "0")}`;
}

/** Opaque, stable id for a task within a lesson — doubles as a
 * CurriculumLesson.canDo entry (progress-bar bookkeeping; see
 * LessonProgressBar, which only ever counts these, never displays them)
 * and as the string the tutor is asked to echo back into
 * TutorResponse.completedGoals once that task is actually done (see
 * app/api/chat/route.ts's buildLessonPlanBlock and persona.ts's LESSON
 * COMPLETION section). Not lesson-code-prefixed because canDoGoals is
 * always scoped to a single lesson already (see orchestrator.startLesson,
 * which passes lesson?.canDo for the CURRENT lesson only). */
export function taskId(order: number): string {
  return `task-${order}`;
}

// ---- Legacy-shaped view — keeps the existing UI (page.tsx, TipsPanel,
// MobileVoiceScreen, LessonProgressBar, LessonCompleteCard) working
// unchanged against data that no longer really has "durationMinutes" or
// "canDo" goals in the old sense. CurriculumLesson is a SUPERSET: the
// original fields are synthesized as best-effort (see buildCurriculumLesson),
// and the real new-format fields (code, skill, order, tasks,
// referenceContent, ...) are carried through alongside them so
// getLessonByCode/getNextLesson can serve BOTH the existing UI and
// app/api/chat/route.ts's roteiro injection from the exact same object,
// without renaming the functions the UI already imports. ----

export interface CurriculumLesson {
  /** "book02-unit01-1a" — see lessonId. */
  id: string;
  book: string;
  unit: string;
  lessonCode: string;
  title: string;
  type: string;
  /** Allotted time for the lesson timer bar (see LessonTimer) — the new
   * curriculum format doesn't specify this per lesson, so every lesson
   * defaults to 15, same as every LEGACY lesson did in practice. */
  durationMinutes: number;
  vocabulary: string[];
  grammarPoints: string[];
  targetPhrases: string[];
  /** Synthesized as one opaque taskId() per task (see its doc comment) —
   * NOT human-readable goal descriptions like the old LEGACY data had.
   * Nothing renders these as text (confirmed: only ever counted), so this
   * is safe. */
  canDo: string[];
  exampleExchanges: { q: string; a: string }[];
  prerequisiteLessonIds: string[];
  notes: string | null;
  cumulativeScope: string[];
  tips: string[];

  // ---- Real new-format fields, for app/api/chat/route.ts ----
  /** "book02" / "unit01" — with code, what identifies the lesson (codes
   * repeat across units: Book 2 / Unit 1 has a 1A too). */
  bookCode: string;
  unitCode: string;
  /** Its unit's principles (see StoredPrinciples). */
  globalPrinciples: string[];
  principlesInheritedFrom?: string;
  code: string;
  skill: string | null;
  order: number;
  practiceNote?: string;
  tasks: CurriculumTask[];
  referenceContent: CurriculumReferenceContent;
  requiresImages: boolean;
  imageNote?: string;
  /** False when the lesson has tasks and none of them can run (see
   * playableTasks) — it can't run until its material exists, so the UI
   * refuses to open it (see TutorApp). */
  playable: boolean;
}

const DEFAULT_DURATION_MINUTES = 15;

/** Vocabulary entries in the source data are often "word - annotation"
 * (e.g. "A - /eI/", "1 – one") — this keeps just the headword for STT
 * vocabulary hinting (see SpeechToTextProvider.setLessonVocabulary),
 * falling back to the whole entry when there's no such separator. */
function headword(entry: string): string {
  return entry.split(/\s[-–—]\s/)[0].trim();
}

/** Pairs up consecutive "A: ..." / "B: ..." lines across every dialogue
 * block into {q, a} exchanges — used for CurriculumLesson.exampleExchanges
 * and targetPhrases. Preamble lines (dialogue titles, Portuguese notes)
 * that don't match the "A:"/"B:" pattern are simply skipped. */
function extractExchanges(dialogues: string[][]): { q: string; a: string }[] {
  const exchanges: { q: string; a: string }[] = [];
  for (const block of dialogues) {
    let lastA: string | undefined;
    for (const line of block) {
      const match = line.match(/^([AB]):\s*(.+)$/);
      if (!match) continue;
      const [, speaker, text] = match;
      if (speaker === "A") {
        lastA = text.trim();
      } else if (speaker === "B" && lastA) {
        exchanges.push({ q: lastA, a: text.trim() });
        lastA = undefined;
      }
    }
  }
  return exchanges;
}

/** The lesson's descriptive title. A plan with no `title`/`skill` (Lesson A)
 * used to fall back to `Lesson ${code}` — which the tutor then announced as
 * "Book 1, Lesson A — Lesson A". The first table caption is the lesson's
 * real heading in the source material, so it comes before that last
 * resort. */
export function lessonTitle(plan: RawLessonPlan): string {
  return (
    plan.title ??
    plan.skill ??
    plan.referenceContent.tables?.find((t) => t.caption)?.caption ??
    `Lesson ${plan.code}`
  );
}

/** Where a lesson sits — its unit's display names and codes (the id is
 * "<bookCode>-<unitCode>-<code>", e.g. "book02-unit01-1a") and the unit's
 * global principles. */
export interface LessonUnitInfo {
  book: string;
  unit: string;
  bookCode: string;
  unitCode: string;
  principles: string[];
  principlesInheritedFrom?: string;
}

export function lessonId(bookCode: string, unitCode: string, code: string): string {
  return `${bookCode}-${unitCode}-${code.trim().toLowerCase()}`;
}

/** Exported so supabase-source.ts builds the exact same CurriculumLesson
 * from database rows as this module builds from the JSON. */
export function buildCurriculumLesson(plan: RawLessonPlan, unitInfo: LessonUnitInfo): CurriculumLesson {
  const title = lessonTitle(plan);
  const exchanges = extractExchanges(plan.referenceContent.dialogues);
  return {
    id: lessonId(unitInfo.bookCode, unitInfo.unitCode, plan.code),
    book: unitInfo.book,
    unit: unitInfo.unit,
    lessonCode: plan.code,
    title,
    type: plan.skill ?? "practice",
    durationMinutes: DEFAULT_DURATION_MINUTES,
    vocabulary: Array.from(new Set([
      ...plan.referenceContent.vocabulary.map(headword),
      // Symbol names live in the SKILL column, not the vocabulary array.
      ...(plan.referenceContent.tables ?? []).flatMap((table) => {
        const column = table.rows[0]?.findIndex((cell) => cell.trim().toUpperCase() === "SKILL") ?? -1;
        return column < 0 ? [] : table.rows.slice(1).map((row) => row[column]?.trim()).filter((word): word is string => !!word);
      }),
    ])),
    grammarPoints: plan.referenceContent.grammarNotes ?? [],
    targetPhrases: exchanges.map((e) => e.q),
    // Tasks that don't run (disabled, or image-only without a picture) are
    // not part of the progress denominator — missing material on our side
    // must not lower the student's score.
    canDo: playableTasks(plan.tasks).map((t) => taskId(t.order)),
    exampleExchanges: exchanges,
    prerequisiteLessonIds: [],
    notes: plan.practiceNote ?? null,
    cumulativeScope: [],
    tips: [],

    bookCode: unitInfo.bookCode,
    unitCode: unitInfo.unitCode,
    globalPrinciples: unitInfo.principles,
    ...(unitInfo.principlesInheritedFrom && { principlesInheritedFrom: unitInfo.principlesInheritedFrom }),
    code: plan.code,
    skill: plan.skill,
    order: plan.order,
    practiceNote: plan.practiceNote,
    tasks: plan.tasks,
    referenceContent: plan.referenceContent,
    requiresImages: plan.requiresImages,
    imageNote: plan.imageNote,
    // Only a lesson EMPTIED by tasks that can't run is unplayable — one
    // with no tasks in the source at all (e.g. 3B) always ran from its
    // reference content and still does.
    playable: plan.tasks.length === 0 || playableTasks(plan.tasks).length > 0,
  };
}

const UNITS = [book01unit01, book01unit03, book01unit04, book01unit05, book02unit01, book02unit02] as unknown as CurriculumUnitData[];

/** While only Book 1 / Unit 1 has principles, the other units inherit them
 * (marked as such) — the same rule scripts/carregar-material.cjs stores in
 * Supabase. */
const PRINCIPLES_SOURCE = UNITS.find((u) => (u.globalPrinciples ?? []).length > 0);

const ALL_LESSONS: CurriculumLesson[] = UNITS.flatMap((unit) => {
  const own = unit.globalPrinciples ?? [];
  const inherit = own.length === 0 && PRINCIPLES_SOURCE !== undefined && PRINCIPLES_SOURCE !== unit;
  const unitInfo: LessonUnitInfo = {
    book: unit.book,
    unit: unit.unit,
    bookCode: codeFromLabel("book", unit.book),
    unitCode: codeFromLabel("unit", unit.unit),
    principles: inherit ? PRINCIPLES_SOURCE.globalPrinciples : own,
    ...(inherit && { principlesInheritedFrom: `${PRINCIPLES_SOURCE.book} / ${PRINCIPLES_SOURCE.unit}` }),
  };
  return unit.lessons.map((plan) => buildCurriculumLesson(plan, unitInfo));
});

/** The first unit's principles (the app uses each lesson's own —
 * CurriculumLesson.globalPrinciples). */
export function getGlobalPrinciples(): string[] {
  return ALL_LESSONS[0]?.globalPrinciples ?? [];
}

/** By id ("book02-unit01-1a") or, for old links, by bare code ("1A" — the
 * first lesson with that code in course order, i.e. Book 1's). */
export function getLessonByCode(ref: string): CurriculumLesson | undefined {
  return findLessonByRef(ALL_LESSONS, ref);
}

/** Safety-net default (see app/api/chat/route.ts's fallback logic) — the
 * first lesson in course order ("A" — Boas-vindas). Used whenever a
 * requested lesson can't be resolved, so the tutor NEVER runs a session
 * with no roteiro at all. */
export function getFirstLesson(): CurriculumLesson {
  return ALL_LESSONS[0];
}

/** Compact list of every lesson in the course — enough for the tutor to
 * recognize and name a lesson the student references, without teaching it. */
export function getCourseOverview(): { id: string; lessonCode: string; title: string }[] {
  return ALL_LESSONS.map((l) => ({ id: l.id, lessonCode: l.lessonCode, title: l.title }));
}

/** Every lesson in the course, fully resolved, in book → unit → lesson
 * order — for UI that groups or displays lessons (components/LessonGrid). */
export function getAllLessons(): CurriculumLesson[] {
  return ALL_LESSONS;
}

/** The lesson right after `ref` in course order — positional, not a
 * prerequisite-based recommendation. undefined if `ref` isn't found or is
 * the last lesson (see orchestrator.announceLessonComplete). */
export function getNextLesson(ref: string): CurriculumLesson | undefined {
  return nextLessonAfter(ALL_LESSONS, ref);
}
