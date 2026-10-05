import "server-only";
import { createServiceClient } from "../supabase";

// Reads for the /admin pages. Everything goes through the service client
// (RLS has no policies), so this module must never reach a client bundle.

export const LESSON_IMAGES_BUCKET = "lesson-images";

export type LessonStatus = "ativo" | "pendente" | "desativado";
export const LESSON_STATUSES: LessonStatus[] = ["ativo", "pendente", "desativado"];

export interface AdminLessonSummary {
  id: string;
  code: string;
  title: string | null;
  status: LessonStatus;
  requires_images: boolean;
  order: number;
  edited_fields: string[];
}

export interface AdminUnit {
  id: string;
  code: string;
  title: string | null;
  order: number;
  lessons: AdminLessonSummary[];
}

export interface AdminBook {
  id: string;
  code: string;
  title: string;
  order: number;
  units: AdminUnit[];
}

export async function listCurriculum(): Promise<AdminBook[]> {
  const { data, error } = await createServiceClient()
    .from("books")
    .select(
      'id, code, title, order, units(id, code, title, order, ' +
        'lessons(id, code, title, status, requires_images, order, edited_fields))'
    );
  if (error) throw error;
  const books = (data ?? []) as unknown as AdminBook[];
  books.sort((a, b) => a.order - b.order);
  for (const book of books) {
    book.units.sort((a, b) => a.order - b.order);
    for (const unit of book.units) unit.lessons.sort((a, b) => a.order - b.order);
  }
  return books;
}

export interface AdminLesson {
  id: string;
  code: string;
  title: string | null;
  skill: string | null;
  status: LessonStatus;
  practice_note: string | null;
  legacy_tasks: unknown;
  requires_images: boolean;
  image_note: string | null;
  edited_fields: string[];
  unit: { id: string; code: string; title: string | null; book: { code: string; title: string } };
}

const LESSON_COLUMNS =
  "id, code, title, skill, status, practice_note, legacy_tasks, requires_images, image_note, edited_fields, " +
  "unit:units!inner(id, code, title, book:books!inner(code, title))";

/** Every lesson with this code — more than one once several units exist
 * (codes repeat per unit); `unitId` narrows it to one. */
export async function findLessons(code: string, unitId?: string): Promise<AdminLesson[]> {
  let query = createServiceClient().from("lessons").select(LESSON_COLUMNS).eq("code", code);
  if (unitId) query = query.eq("unit_id", unitId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as AdminLesson[];
}

export async function getLessonById(id: string): Promise<AdminLesson | undefined> {
  const { data, error } = await createServiceClient().from("lessons").select(LESSON_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  return (data ?? undefined) as unknown as AdminLesson | undefined;
}

export interface AdminStep {
  id: string;
  order: number;
  mechanic: string;
  prompt_text: string | null;
  image_path: string | null;
  edited_manually: boolean;
}

export async function listSteps(lessonId: string): Promise<AdminStep[]> {
  const { data, error } = await createServiceClient()
    .from("steps")
    .select("id, order, mechanic, prompt_text, image_path, edited_manually")
    .eq("lesson_id", lessonId)
    .order("order");
  if (error) throw error;
  return data ?? [];
}

/** Storage folder for a lesson's images: book01/unit01/1B */
export function lessonImageFolder(lesson: AdminLesson): string {
  return `${lesson.unit.book.code}/${lesson.unit.code}/${lesson.code}`;
}

export interface LessonImage {
  path: string;
  name: string;
  url: string | null;
}

/** Images already in the lesson's folder, with 1-hour signed URLs for preview
 * (the bucket is private). */
export async function listLessonImages(lesson: AdminLesson): Promise<LessonImage[]> {
  const storage = createServiceClient().storage.from(LESSON_IMAGES_BUCKET);
  const folder = lessonImageFolder(lesson);
  const { data, error } = await storage.list(folder, { sortBy: { column: "name", order: "asc" } });
  if (error) throw error;
  const files = (data ?? []).filter((f) => f.id); // folders have no id
  if (files.length === 0) return [];
  const paths = files.map((f) => `${folder}/${f.name}`);
  const { data: signed } = await storage.createSignedUrls(paths, 3600);
  return paths.map((path, i) => ({ path, name: files[i].name, url: signed?.[i]?.signedUrl ?? null }));
}
