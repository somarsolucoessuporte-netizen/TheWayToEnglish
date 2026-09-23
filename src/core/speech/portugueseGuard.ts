/**
 * School rule: Portuguese is WRITTEN explanation only, never spoken — only
 * English goes to the TTS. The persona says so (see persona.ts's LANGUAGE
 * STRATEGY), but a model still sometimes writes a Portuguese explanation
 * straight into speech.english ("Em português dizemos 'A', mas em inglês é
 * apenas a letra A."), and that field is read aloud. This is the mechanical
 * backstop: split speech.english into sentences and pull out every sentence
 * that reads as Portuguese. Used server-side by /api/chat (which moves them
 * into speech.portuguese, and regenerates the turn if nothing English is
 * left) and client-side right before TTS as a last line of defense.
 *
 * Deliberately cheap: a sentence is Portuguese if it has 2+ hits (or 1 hit
 * making up at least a third of its words), where a hit is a high-frequency
 * Portuguese function/lesson word, or any word carrying a Portuguese-only
 * diacritic. A lone name like "José" in an English sentence stays English.
 */

const PT_STOPWORDS = new Set([
  "em", "não", "nao", "você", "voce", "vocês", "dizemos", "dizer", "diga", "vamos", "mas", "apenas",
  "dessa", "desse", "desta", "deste", "forma", "usamos", "usar", "português", "portugues", "inglês",
  "ingles", "tentar", "tente", "novo", "nova", "correto", "correta", "agora", "é", "está", "estão",
  "muito", "bem", "para", "com", "uma", "isso", "isto", "também", "tambem", "porque", "então",
  "entao", "letra", "palavra", "palavras", "repita", "repete", "ótimo", "otimo", "ótima", "obrigado",
  "obrigada", "quase", "certo", "certa", "vez", "mais", "só", "ainda", "aqui", "que", "seu", "sua",
  "eu", "tem", "temos", "pronúncia", "pronuncia", "significa", "quer", "fala", "falar", "ouvir",
  "exemplo", "dessa", "nossa", "nosso", "pode", "podemos", "vai", "fazer", "frase", "som", "pergunta",
  "resposta", "lição", "licao", "parabéns", "parabens", "olá", "ola", "tudo", "sempre", "nunca",
]);

/** Letters that don't occur in English words — one of them in a word is a
 * strong Portuguese signal on its own. */
const PT_DIACRITIC = /[ãõçáàâêéíóôú]/i;

function words(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .split(/[^\p{L}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

export function isPortugueseSentence(sentence: string): boolean {
  const ws = words(sentence);
  if (ws.length === 0) return false;
  let hits = 0;
  for (const w of ws) {
    if (PT_STOPWORDS.has(w) || PT_DIACRITIC.test(w)) hits++;
  }
  return hits >= 2 || (hits >= 1 && hits / ws.length >= 1 / 3);
}

/** Splits on sentence-ending punctuation, keeping it with its sentence. */
function sentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

/**
 * Returns `english` with every Portuguese sentence removed, plus those
 * sentences (in order). `portuguese` is empty when the text was clean —
 * callers can use that to decide whether to log/act at all.
 */
export function splitOutPortuguese(text: string): { english: string; portuguese: string[] } {
  const english: string[] = [];
  const portuguese: string[] = [];
  for (const s of sentences(text)) (isPortugueseSentence(s) ? portuguese : english).push(s);
  return { english: portuguese.length ? english.join(" ") : text, portuguese };
}
