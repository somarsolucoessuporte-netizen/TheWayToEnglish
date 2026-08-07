/**
 * Countries/continents the curriculum can plausibly mention (see e.g.
 * app-config/curriculum/book01-unit01.json) — used by ChatLog to decide,
 * by plain string matching, when a tutor reply earns an illustrative
 * image (see VisualCard + /api/image). Deterministic by design: this used
 * to be a "visual" field the model filled in on TutorResponse itself, but
 * gpt-4o-mini followed that instruction inconsistently — matching against
 * a fixed list after the fact is 100% consistent regardless of the
 * model's mood. Extend this list as the curriculum grows.
 */
export const VISUAL_ENTITIES = [
  "Brazil",
  "Argentina",
  "Chile",
  "United States",
  "Canada",
  "Jamaica",
  "Cuba",
  "Egypt",
  "Morocco",
  "South Africa",
  "Senegal",
  "China",
  "Japan",
  "Korea",
  "Italy",
  "France",
  "Portugal",
  "Germany",
  "Africa",
  "America",
  "North America",
  "South America",
  "Asia",
  "Europe",
  "Australia",
] as const;
