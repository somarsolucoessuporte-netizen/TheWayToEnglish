import "server-only";
import { createServiceClient } from "./supabase";

// Signed URLs for the lesson-images bucket (private — the student's browser
// only ever gets short-lived links). Kept in memory well inside their
// lifetime, so asking the same item again costs no Supabase call.

export const LESSON_IMAGES_BUCKET = "lesson-images";

const URL_LIFETIME_S = 3600;
const REUSE_FOR_MS = 45 * 60_000;

const cache = new Map<string, { url: string; until: number }>();

/** Signed URL per storage path, in order; a path that fails to sign is left
 * out (the screen shows the others, or nothing). */
export async function signLessonImages(paths: string[]): Promise<string[]> {
  const now = Date.now();
  const missing = paths.filter((p) => (cache.get(p)?.until ?? 0) <= now);
  if (missing.length > 0) {
    const { data, error } = await createServiceClient().storage.from(LESSON_IMAGES_BUCKET).createSignedUrls(missing, URL_LIFETIME_S);
    if (error) throw error;
    for (const d of data ?? []) {
      if (d.path && d.signedUrl) cache.set(d.path, { url: d.signedUrl, until: now + REUSE_FOR_MS });
    }
  }
  return paths.map((p) => cache.get(p)?.url).filter((u): u is string => !!u);
}
