import { VISUAL_ENTITIES } from "@/app-config/visual-entities";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scans `text` for whole-word, case-insensitive matches against
 * VISUAL_ENTITIES (see its doc comment) and returns the one that appears
 * EARLIEST in the text — "a primeira entidade encontrada" reading the
 * sentence left to right, not the first entry in the list. This also
 * naturally resolves the "North America" vs "America" overlap: when both
 * match the same mention, the multi-word entity's match always starts
 * earlier (it's a prefix of the same occurrence), so it wins without any
 * special-casing; the length tiebreak below only matters for the
 * vanishingly unlikely case of two entities matching at the exact same
 * index. Returns undefined if nothing in the list appears at all.
 */
export function detectVisualEntity(text: string): string | undefined {
  let best: { entity: string; index: number } | undefined;
  for (const entity of VISUAL_ENTITIES) {
    const match = new RegExp(`\\b${escapeRegExp(entity)}\\b`, "i").exec(text);
    if (!match) continue;
    if (!best || match.index < best.index || (match.index === best.index && entity.length > best.entity.length)) {
      best = { entity, index: match.index };
    }
  }
  return best?.entity;
}
