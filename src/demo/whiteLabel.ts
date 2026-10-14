import { DEFAULT_PERSONA, type Persona } from "@/app-config/persona";
import type { CurriculumLesson } from "@/app-config/curriculum";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Swaps the default tutor name/school for the demo school's, case-insensitively
 * (the curriculum writes "The Way to English" with a lowercase "to"). Mirrors
 * the server-side applyPersonaToText in app/api/chat/route.ts, but runs on the
 * client for TEXT THAT IS DISPLAYED (lesson titles, tips…), not sent to the AI.
 */
export function applyPersonaToText(text: string, override: Partial<Persona>): string {
  let out = text;
  if (override.escola_nome_ia) {
    out = out.replace(
      new RegExp(escapeRegExp(DEFAULT_PERSONA.escola_nome_ia), "gi"),
      override.escola_nome_ia,
    );
  }
  if (override.nome_tutor) {
    out = out.replace(new RegExp(escapeRegExp(DEFAULT_PERSONA.nome_tutor), "gi"), override.nome_tutor);
    const firstName = DEFAULT_PERSONA.nome_tutor.split(" ")[0];
    out = out.replace(new RegExp("\\b" + escapeRegExp(firstName) + "\\b", "gi"), override.nome_tutor);
  }
  return out;
}

// Keys that hold identifiers/codes (never displayed prose) — never rewritten,
// so a lesson code or id can never be mangled by the swap.
const ID_KEYS = new Set([
  "id",
  "code",
  "lessonCode",
  "book",
  "unit",
  "type",
  "canDo",
  "prerequisiteLessonIds",
]);

function deepReplace(value: unknown, override: Partial<Persona>, key?: string): unknown {
  if (typeof value === "string") {
    return key && ID_KEYS.has(key) ? value : applyPersonaToText(value, override);
  }
  if (Array.isArray(value)) return value.map((v) => deepReplace(v, override, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepReplace(v, override, k);
    return out;
  }
  return value;
}

/**
 * White-labels the lessons the demo UI renders (grid, current-lesson label,
 * completion card) so a school's prospect never sees "The Way To English" in a
 * lesson title. These lessons are display-only: the AI prompt re-fetches the
 * real lesson server-side by code (see app/api/chat/route.ts), so this never
 * touches what the tutor is actually taught. No override => lessons untouched.
 */
export function whiteLabelLessons(
  lessons: CurriculumLesson[],
  override: Partial<Persona>,
): CurriculumLesson[] {
  if (!override.escola_nome_ia && !override.nome_tutor) return lessons;
  return deepReplace(lessons, override) as CurriculumLesson[];
}
