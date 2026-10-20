import "server-only";
import { createServiceClient } from "../../lib/supabase";
import {
  buildCurriculumLesson,
  principlesOf,
  type CurriculumLesson,
  type CurriculumReferenceContent,
  type CurriculumTask,
  type LessonUnitInfo,
  type RawLessonPlan,
  type StoredPrinciples,
} from "./json-source";
import { findLessonByRef, nextLessonAfter } from "./lookup";

// The curriculum read from Supabase — the same functions as json-source.ts,
// async. The app reads it through ./index.ts (loadSnapshot + JSON fallback);
// the per-function exports are what scripts/test-supabase-parity.cjs checks.
//
// Server-only: uses SUPABASE_SERVICE_ROLE_KEY (RLS has no policies, so only
// the service role can read). Never import this from a "use client" file.
//
// Lessons are addressed by id ("book02-unit01-1a" — book + unit + code; see
// lookup.ts), a bare code meaning the first match in course order.

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
  global_principles: StoredPrinciples;
  book: { code: string; title: string; order: number };
  lessons: LessonRow[];
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

function unitInfoOf(unit: UnitRow): LessonUnitInfo {
  const { principles, inheritedFrom } = principlesOf(unit.global_principles);
  return {
    book: unit.book.title,
    unit: unit.title ?? unit.code,
    bookCode: unit.book.code,
    unitCode: unit.code,
    principles,
    ...(inheritedFrom && { principlesInheritedFrom: inheritedFrom }),
  };
}

async function loadLessons(): Promise<CurriculumLesson[]> {
  const units = await loadUnits();
  return units.flatMap((unit) => {
    const unitInfo = unitInfoOf(unit);
    return unit.lessons.map((row) => buildCurriculumLesson(toPlan(row), unitInfo));
  });
}

/** Everything the app needs in one query: every lesson (book → unit → lesson
 * order) plus the first unit's global principles. Throws on any Supabase
 * error or an empty curriculum, so the caller can fall back to the JSON. */
export async function loadSnapshot(): Promise<{ lessons: CurriculumLesson[]; principles: string[] }> {
  const lessons = await loadLessons();
  if (lessons.length === 0) throw new Error("Supabase curriculum is empty");
  return { lessons, principles: lessons[0].globalPrinciples };
}

export async function getGlobalPrinciples(): Promise<string[]> {
  const [first] = await loadLessons();
  return first?.globalPrinciples ?? [];
}

export async function getLessonByCode(ref: string): Promise<CurriculumLesson | undefined> {
  return findLessonByRef(await loadLessons(), ref);
}

export async function getFirstLesson(): Promise<CurriculumLesson> {
  const [first] = await loadLessons();
  if (!first) throw new Error("No lessons in the Supabase curriculum");
  return first;
}

export async function getCourseOverview(): Promise<{ id: string; lessonCode: string; title: string }[]> {
  return (await loadLessons()).map((l) => ({ id: l.id, lessonCode: l.lessonCode, title: l.title }));
}

export async function getAllLessons(): Promise<CurriculumLesson[]> {
  return loadLessons();
}

export async function getNextLesson(ref: string): Promise<CurriculumLesson | undefined> {
  return nextLessonAfter(await loadLessons(), ref);
}
