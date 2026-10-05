import "server-only";
import { createServiceClient } from "../../lib/supabase";
import {
  buildCurriculumLesson,
  lessonTitle,
  type CurriculumLesson,
  type CurriculumReferenceContent,
  type CurriculumTask,
  type LessonUnitInfo,
  type RawLessonPlan,
} from "./index";

// Same functions as ./index.ts, async, reading the curriculum from Supabase
// instead of the bundled JSON. NOT wired into the app yet — index.ts still
// serves the student; switching over is a separate commit once
// scripts/test-supabase-parity.cjs passes against the live database.
//
// Server-only: uses SUPABASE_SERVICE_ROLE_KEY (RLS has no policies, so only
// the service role can read). Never import this from a "use client" file.
//
// Like index.ts, lessons are addressed by code alone — fine while the
// database holds a single unit, ambiguous once a second unit repeats "A".

interface LessonRow {
  code: string;
  title: string | null;
  skill: string | null;
  order: number;
  reference_content: CurriculumReferenceContent | null;
  practice_note: string | null;
  legacy_tasks: CurriculumTask[] | null;
  requires_images: boolean;
  image_note: string | null;
}

interface UnitRow {
  code: string;
  title: string | null;
  order: number;
  global_principles: string[] | null;
  book: { code: string; title: string; order: number };
  lessons: LessonRow[];
}

interface LoadedLesson {
  plan: RawLessonPlan;
  unitInfo: LessonUnitInfo;
}

const supabase = createServiceClient;

function toPlan(row: LessonRow): RawLessonPlan {
  return {
    code: row.code,
    title: row.title,
    skill: row.skill,
    order: row.order,
    ...(row.practice_note != null && { practiceNote: row.practice_note }),
    tasks: row.legacy_tasks ?? [],
    referenceContent: row.reference_content ?? { dialogues: [], vocabulary: [] },
    requiresImages: row.requires_images,
    ...(row.image_note != null && { imageNote: row.image_note }),
  };
}

/** Every unit, in book → unit order, with its lessons in lesson order. */
async function loadUnits(): Promise<UnitRow[]> {
  const { data, error } = await supabase()
    .from("units")
    .select(
      'code, title, order, global_principles, book:books!inner(code, title, order), ' +
        'lessons(code, title, skill, order, reference_content, practice_note, legacy_tasks, requires_images, image_note)'
    );
  if (error) throw error;
  const units = (data ?? []) as unknown as UnitRow[];
  units.sort((a, b) => a.book.order - b.book.order || a.order - b.order);
  for (const unit of units) unit.lessons.sort((a, b) => a.order - b.order);
  return units;
}

async function loadLessons(): Promise<LoadedLesson[]> {
  const units = await loadUnits();
  return units.flatMap((unit) => {
    const unitInfo: LessonUnitInfo = {
      book: unit.book.title,
      unit: unit.title ?? unit.code,
      idPrefix: `${unit.book.code}-${unit.code}`,
    };
    return unit.lessons.map((row) => ({ plan: toPlan(row), unitInfo }));
  });
}

function normalize(code: string): string {
  return code.trim().toLowerCase();
}

function build({ plan, unitInfo }: LoadedLesson): CurriculumLesson {
  return buildCurriculumLesson(plan, unitInfo);
}

export async function getGlobalPrinciples(): Promise<string[]> {
  const [first] = await loadUnits();
  return first?.global_principles ?? [];
}

export async function getLessonByCode(code: string): Promise<CurriculumLesson | undefined> {
  const normalized = normalize(code);
  const found = (await loadLessons()).find((l) => l.plan.code.toLowerCase() === normalized);
  return found ? build(found) : undefined;
}

export async function getFirstLesson(): Promise<CurriculumLesson> {
  const [first] = await loadLessons();
  if (!first) throw new Error("No lessons in the Supabase curriculum");
  return build(first);
}

export async function getCourseOverview(): Promise<{ lessonCode: string; title: string }[]> {
  return (await loadLessons()).map(({ plan }) => ({ lessonCode: plan.code, title: lessonTitle(plan) }));
}

export async function getAllLessons(): Promise<CurriculumLesson[]> {
  return (await loadLessons()).map(build);
}

export async function getNextLesson(code: string): Promise<CurriculumLesson | undefined> {
  const normalized = normalize(code);
  const lessons = await loadLessons();
  const index = lessons.findIndex((l) => l.plan.code.toLowerCase() === normalized);
  if (index === -1) return undefined;
  const next = lessons[index + 1];
  return next ? build(next) : undefined;
}
