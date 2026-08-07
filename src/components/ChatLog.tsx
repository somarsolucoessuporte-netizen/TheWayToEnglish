"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ChatEntry } from "@/core/conversation/orchestrator";
import { detectVisualEntity } from "@/core/utils/detectVisualEntity";
import { CorrectionCard } from "./CorrectionCard";
import { MiniCorrectionCard } from "./MiniCorrectionCard";
import { VisualCard } from "./VisualCard";

/** Slices `text` down to its first `wordsShown` words for the progressive
 * reveal (see orchestrator's updateReveal) — `undefined` means "not a
 * progressively-revealed entry at all", which shows everything, so every
 * entry that doesn't opt into the reveal machinery (scripted announcements,
 * etc.) renders exactly as it always did. */
export function revealedText(text: string, wordsShown: number | undefined): string {
  if (wordsShown === undefined) return text;
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, wordsShown).join(" ");
}

/** `compact` swaps the full CorrectionCard (explanation + pronunciation
 * hint text) for MiniCorrectionCard (just ❌word → ✅word + audio buttons)
 * — used on mobile, where the explanation was already spoken aloud by the
 * tutor and repeating it in writing is just clutter on a small screen. */
export function ChatLog({ entries, compact = false }: { entries: ChatEntry[]; compact?: boolean }) {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  // Which entity (if any — see detectVisualEntity/app-config/visual-
  // entities.ts) earns an illustrative image for a given tutor entry —
  // code-side detection, not a model-generated field (see TutorResponse's
  // history: the model followed a "visual" instruction inconsistently).
  // Only the FIRST message that mentions a given entity gets the card —
  // recomputed from `entries` each time so it never gets out of sync with
  // the actual chat history, same dedupe behavior as before.
  const visualEntityForIndex = useMemo(() => {
    const seen = new Set<string>();
    const result = new Map<number, string>();
    entries.forEach((entry, i) => {
      if (entry.role !== "tutor" || entry.pending) return;
      const entity = detectVisualEntity(entry.response.speech.english);
      if (entity && !seen.has(entity)) {
        seen.add(entity);
        result.set(i, entity);
      }
    });
    return result;
  }, [entries]);

  // Flags the student's own message when the tutor's very next reply
  // praises it — the flash + checkmark are a reaction to that specific
  // answer, not the conversation in general. Once an entry lands in this
  // set it stays there for the entry's lifetime (entries are never
  // reordered), so the flash animation fires exactly once and the
  // checkmark stays permanent, per spec.
  //
  // Requires correction to be absent, not just praise to be true: praise
  // and correction can both come back set on the same TutorResponse (the
  // model praising effort on a turn that still contains a language
  // mistake), and showing a green "you got it right" checkmark right next
  // to an error card is a contradictory signal — the student can't tell if
  // they were right or wrong. A turn with a correction is never a "you got
  // it right" turn for checkmark purposes, regardless of the praise flag.
  const praisedUserIndex = useMemo(() => {
    const praised = new Set<number>();
    entries.forEach((entry, i) => {
      if (
        entry.role === "tutor" &&
        entry.response.praise &&
        !entry.response.correction &&
        entries[i - 1]?.role === "user"
      ) {
        praised.add(i - 1);
      }
    });
    return praised;
  }, [entries]);

  return (
    <div className="chat-log" ref={logRef}>
      {entries.map((entry, i) => {
        if (entry.role === "user") {
          return (
            <div key={i} className={`msg user${praisedUserIndex.has(i) ? " msg-correct" : ""}`}>
              {entry.text}
              {praisedUserIndex.has(i) && (
                <span className="msg-correct-badge" aria-label="Resposta correta">
                  ✓
                </span>
              )}
            </div>
          );
        }

        // pending: the response has arrived but hasn't started playing
        // yet — nothing renders except a typing indicator (see
        // orchestrator's pushPendingTutorEntry) until the audio's real
        // "start" event flips this and begins the word-by-word reveal.
        if (entry.pending) {
          return (
            <div key={i} className="msg bot typing-indicator" aria-label="Respondendo">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          );
        }

        const englishShown = revealedText(entry.response.speech.english, entry.reveal?.englishWordsShown);
        const portugueseShown = revealedText(entry.response.speech.portuguese, entry.reveal?.portugueseWordsShown);

        return (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="msg bot">
              {/* Text order mirrors spoken order: normally English-then-
                  Portuguese, but reversed for a correction so the on-screen
                  text doesn't read backwards from what the student just
                  heard (see orchestrator's correction-aware speakParts
                  ordering). Each half is only as much of the full line as
                  has been revealed so far — see revealedText. */}
              {entry.response.correction ? (
                <>
                  {portugueseShown && <span className="msg-pt">{portugueseShown}</span>}
                  {englishShown && portugueseShown && <br />}
                  {englishShown}
                </>
              ) : (
                <>
                  {englishShown}
                  {englishShown && portugueseShown && <br />}
                  {portugueseShown && <span className="msg-pt">{portugueseShown}</span>}
                </>
              )}
            </div>
            {entry.response.correction &&
              (compact ? (
                <MiniCorrectionCard correction={entry.response.correction} />
              ) : (
                <CorrectionCard correction={entry.response.correction} />
              ))}
            {visualEntityForIndex.has(i) && (
              <VisualCard query={visualEntityForIndex.get(i)!} caption={visualEntityForIndex.get(i)!} />
            )}
          </div>
        );
      })}
    </div>
  );
}
