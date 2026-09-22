import curriculumData from "./book01-unit01.json";

// ---- New-format shape (book01-unit01.json) — the real curriculum data:
// a task-by-task script the tutor executes, plus reference material
// (dialogues/vocabulary/tables) it draws on while executing it. See
// app/api/chat/route.ts's buildLessonPlanBlock for how this is injected
// into the system prompt. ----

export interface CurriculumTask {
  order: number;
  instruction: string;
  type: string;
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
}

interface CurriculumUnitData {
  book: string;
  unit: string;
  unitTheme?: string;
  globalPrinciples: string[];
  tutorIdentity?: { name: string; age: number; nationality: string; occupation: string };
  lessons: RawLessonPlan[];
}

interface RawLessonPlan {
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

const UNIT = curriculumData as CurriculumUnitData;
const ALL_LESSON_PLANS: RawLessonPlan[] = UNIT.lessons;

function normalize(code: string): string {
  return code.trim().toLowerCase();
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

export function getGlobalPrinciples(): string[] {
  return UNIT.globalPrinciples ?? [];
}

// ---- Legacy-shaped view — keeps the existing UI (page.tsx, TipsPanel,
// MobileVoiceScreen, LessonProgressBar, LessonCompleteCard) working
// unchanged against data that no longer really has "durationMinutes" or
// "canDo" goals in the old sense. CurriculumLesson is a SUPERSET: the
// original fields are synthesized as best-effort (see toCurriculumLesson),
// and the real new-format fields (code, skill, order, tasks,
// referenceContent, ...) are carried through alongside them so
// getLessonByCode/getNextLesson can serve BOTH the existing UI and
// app/api/chat/route.ts's roteiro injection from the exact same object,
// without renaming the functions the UI already imports. ----

export interface CurriculumLesson {
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
  code: string;
  skill: string | null;
  order: number;
  practiceNote?: string;
  tasks: CurriculumTask[];
  referenceContent: CurriculumReferenceContent;
  requiresImages: boolean;
  imageNote?: string;
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

function toCurriculumLesson(plan: RawLessonPlan): CurriculumLesson {
  const title = plan.title ?? plan.skill ?? `Lesson ${plan.code}`;
  const exchanges = extractExchanges(plan.referenceContent.dialogues);
  return {
    id: `book01-unit01-${plan.code.toLowerCase()}`,
    book: UNIT.book,
    unit: UNIT.unit,
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
    canDo: plan.tasks.map((t) => taskId(t.order)),
    exampleExchanges: exchanges,
    prerequisiteLessonIds: [],
    notes: plan.practiceNote ?? null,
    cumulativeScope: [],
    tips: [],

    code: plan.code,
    skill: plan.skill,
    order: plan.order,
    practiceNote: plan.practiceNote,
    tasks: plan.tasks,
    referenceContent: plan.referenceContent,
    requiresImages: plan.requiresImages,
    imageNote: plan.imageNote,
  };
}

export function getLessonByCode(code: string): CurriculumLesson | undefined {
  const normalized = normalize(code);
  const plan = ALL_LESSON_PLANS.find((l) => l.code.toLowerCase() === normalized);
  return plan ? toCurriculumLesson(plan) : undefined;
}

/** Safety-net default (see app/api/chat/route.ts's fallback logic) — the
 * first lesson in the curriculum's own array order ("A" — Boas-vindas as
 * of this JSON). Used whenever a requested lesson code can't be resolved,
 * so the tutor NEVER runs a session with no roteiro at all. */
export function getFirstLesson(): CurriculumLesson {
  return toCurriculumLesson(ALL_LESSON_PLANS[0]);
}

/** Compact list of every lesson in the course — enough for the tutor to
 * recognize and name a lesson the student references, without teaching it. */
export function getCourseOverview(): { lessonCode: string; title: string }[] {
  return ALL_LESSON_PLANS.map((l) => ({ lessonCode: l.code, title: l.title ?? l.skill ?? `Lesson ${l.code}` }));
}

/** Every lesson in the course, fully resolved (book/unit/code/title and
 * everything else CurriculumLesson carries) — for UI that needs to group
 * or display lessons using the curriculum's own fields (see
 * components/LessonGrid.tsx), as opposed to getCourseOverview's
 * lessonCode+title-only shape (built for injecting into the AI prompt). */
export function getAllLessons(): CurriculumLesson[] {
  return ALL_LESSON_PLANS.map(toCurriculumLesson);
}

/** The lesson immediately after `code` in the curriculum's own array order
 * (book01-unit01.json's sequence) — not a prerequisite-based recommendation,
 * just positional order. undefined if `code` isn't found or is the last
 * lesson in the course — see orchestrator.announceLessonComplete's doc
 * comment for how the caller handles that case. */
export function getNextLesson(code: string): CurriculumLesson | undefined {
  const normalized = normalize(code);
  const index = ALL_LESSON_PLANS.findIndex((l) => l.code.toLowerCase() === normalized);
  if (index === -1) return undefined;
  const plan = ALL_LESSON_PLANS[index + 1];
  return plan ? toCurriculumLesson(plan) : undefined;
}
