import "server-only";
import * as json from "./json-source";
import type { CurriculumLesson } from "./json-source";
import { findLessonByCode, nextLessonAfter } from "./lookup";
import { loadSnapshot } from "./supabase-source";

// The app's curriculum: read from Supabase (edited in /admin), with the
// bundled JSON as fallback whenever Supabase errors, times out, or is empty —
// a lesson must never fail to start because the database is unreachable.
//
// Server-only (service-role key). Client code gets the lessons as props from
// app/page.tsx and looks them up with ./lookup.
//
// A snapshot is kept for SNAPSHOT_TTL_MS so a chat turn (3–4 lookups) costs
// at most one query; /admin edits reach the tutor within that window. A JSON
// fallback is kept for FALLBACK_TTL_MS: during an outage each window pays the
// Supabase timeout once, not once per lookup.

export * from "./json-source";
export { findLessonByCode, nextLessonAfter } from "./lookup";

const SNAPSHOT_TTL_MS = 30_000;
const FALLBACK_TTL_MS = 15_000;
const SUPABASE_TIMEOUT_MS = 4_000;

interface Snapshot {
  lessons: CurriculumLesson[];
  principles: string[];
  source: "supabase" | "json";
}

let cached: { snapshot: Snapshot; expiresAt: number } | undefined;
let inFlight: Promise<Snapshot> | undefined;

function jsonSnapshot(): Snapshot {
  return { lessons: json.getAllLessons(), principles: json.getGlobalPrinciples(), source: "json" };
}

async function fetchSnapshot(): Promise<Snapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${SUPABASE_TIMEOUT_MS} ms`)), SUPABASE_TIMEOUT_MS);
    });
    const { lessons, principles } = await Promise.race([loadSnapshot(), timeout]);
    const snapshot: Snapshot = { lessons, principles, source: "supabase" };
    cached = { snapshot, expiresAt: Date.now() + SNAPSHOT_TTL_MS };
    return snapshot;
  } catch (error) {
    const reason = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    console.error("[curriculum] Supabase indisponível — usando o JSON:", reason);
    const snapshot = jsonSnapshot();
    cached = { snapshot, expiresAt: Date.now() + FALLBACK_TTL_MS };
    return snapshot;
  } finally {
    clearTimeout(timer);
  }
}

async function snapshot(): Promise<Snapshot> {
  if (cached && Date.now() < cached.expiresAt) return cached.snapshot;
  inFlight ??= fetchSnapshot().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

/** Where the current curriculum came from — for logs and tests. */
export async function getCurriculumSource(): Promise<Snapshot["source"]> {
  return (await snapshot()).source;
}

export async function getGlobalPrinciples(): Promise<string[]> {
  return (await snapshot()).principles;
}

export async function getLessonByCode(code: string): Promise<CurriculumLesson | undefined> {
  return findLessonByCode((await snapshot()).lessons, code);
}

/** Safety-net default for an unresolvable lesson code (see
 * app/api/chat/route.ts) — the first lesson in curriculum order. */
export async function getFirstLesson(): Promise<CurriculumLesson> {
  return (await snapshot()).lessons[0];
}

export async function getCourseOverview(): Promise<{ lessonCode: string; title: string }[]> {
  return (await snapshot()).lessons.map((l) => ({ lessonCode: l.lessonCode, title: l.title }));
}

export async function getAllLessons(): Promise<CurriculumLesson[]> {
  return (await snapshot()).lessons;
}

export async function getNextLesson(code: string): Promise<CurriculumLesson | undefined> {
  return nextLessonAfter((await snapshot()).lessons, code);
}
