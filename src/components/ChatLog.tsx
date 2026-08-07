"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ChatEntry } from "@/core/conversation/orchestrator";
import { CorrectionCard } from "./CorrectionCard";
import { MiniCorrectionCard } from "./MiniCorrectionCard";
import { VisualCard } from "./VisualCard";

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

  // A query only renders its image the first time it shows up in the
  // session — recomputed from `entries` each time so it never gets out of
  // sync with the actual chat history.
  const firstOccurrenceIndex = useMemo(() => {
    const seen = new Set<string>();
    const firstIndexForIndex = new Set<number>();
    entries.forEach((entry, i) => {
      const query = entry.role === "tutor" ? entry.response.visual?.query : undefined;
      if (query && !seen.has(query)) {
        seen.add(query);
        firstIndexForIndex.add(i);
      }
    });
    return firstIndexForIndex;
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
      {entries.map((entry, i) =>
        entry.role === "user" ? (
          <div key={i} className={`msg user${praisedUserIndex.has(i) ? " msg-correct" : ""}`}>
            {entry.text}
            {praisedUserIndex.has(i) && (
              <span className="msg-correct-badge" aria-label="Resposta correta">
                ✓
              </span>
            )}
          </div>
        ) : (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="msg bot">
              {/* Text order mirrors spoken order: normally English-then-
                  Portuguese, but reversed for a correction so the on-screen
                  text doesn't read backwards from what the student just
                  heard (see orchestrator's correction-aware speakParts
                  ordering). */}
              {entry.response.correction ? (
                <>
                  {entry.response.speech.portuguese && <span className="msg-pt">{entry.response.speech.portuguese}</span>}
                  {entry.response.speech.english && entry.response.speech.portuguese && <br />}
                  {entry.response.speech.english}
                </>
              ) : (
                <>
                  {entry.response.speech.english}
                  {entry.response.speech.english && entry.response.speech.portuguese && <br />}
                  {entry.response.speech.portuguese && (
                    <span className="msg-pt">{entry.response.speech.portuguese}</span>
                  )}
                </>
              )}
            </div>
            {entry.response.correction &&
              (compact ? (
                <MiniCorrectionCard correction={entry.response.correction} />
              ) : (
                <CorrectionCard correction={entry.response.correction} />
              ))}
            {entry.response.visual && firstOccurrenceIndex.has(i) && (
              <VisualCard visual={entry.response.visual} />
            )}
          </div>
        )
      )}
    </div>
  );
}
