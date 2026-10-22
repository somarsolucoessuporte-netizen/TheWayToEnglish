"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatEntry } from "@/core/conversation/orchestrator";

/** The picture of the item the tutor is asking right now (signed URLs from
 * /api/chat — see TutorResponse.itemImages), or null for none. Walks the
 * conversation in order: a reply that names an item sets the picture (null
 * when that item has none, so it disappears); a reply that only finishes
 * the picture's task clears it; anything else keeps it on screen (a
 * correction or a nudge still asks the same item). */
export function currentItemImages(entries: ChatEntry[]): string[] | null {
  let shown: { urls: string[]; task: string } | null = null;
  for (const entry of entries) {
    if (entry.role !== "tutor") continue;
    const { item, itemImages, completedGoals } = entry.response;
    if (itemImages !== undefined) {
      shown = itemImages && itemImages.length > 0 && item ? { urls: itemImages, task: item.replace(/-item-\d+$/, "") } : null;
    } else if (shown && completedGoals?.includes(shown.task)) {
      shown = null;
    }
  }
  return shown?.urls ?? null;
}

/** Which tutor entries open a picture bubble in the chat (entry index →
 * urls): the first reply that asks an item with a picture. A correction or
 * a nudge on the same item re-sends the picture (with a fresh signed URL)
 * but gets no new bubble; moving to another item does, and the earlier
 * bubbles stay in the history. */
export function itemImageBubbles(entries: ChatEntry[]): Map<number, string[]> {
  const bubbles = new Map<number, string[]>();
  let lastItem: string | undefined;
  entries.forEach((entry, i) => {
    if (entry.role !== "tutor") return;
    const { item, itemImages } = entry.response;
    if (itemImages === undefined) return;
    if (itemImages && itemImages.length > 0 && item && item !== lastItem) bubbles.set(i, itemImages);
    lastItem = item;
  });
  return bubbles;
}

/** Full-screen view of a picture — portaled to <body> so no transformed
 * ancestor (the mobile drawer) can trap its `position: fixed`. Closes on
 * any click or Esc. */
function ImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="lesson-image-lightbox" role="dialog" aria-label="Picture, enlarged" onClick={onClose}>
      {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from a private bucket */}
      <img src={url} alt="Picture for the question" />
    </div>,
    document.body
  );
}

/** The item's picture as a tutor bubble in the conversation, right above
 * the question (variant "chat"), or floating just above the caption on the
 * mobile avatar screen (variant "mobile") — never over the avatar's face or
 * the Falar button. Tap to enlarge. Nothing is rendered without a picture.
 * The alt text never says what the picture shows: that is the student's
 * answer. */
export function LessonImage({ urls, variant }: { urls: string[] | null; variant: "chat" | "mobile" }) {
  const [enlarged, setEnlarged] = useState<string | null>(null);
  if (!urls || urls.length === 0) return null;
  return (
    <div className={`lesson-image lesson-image--${variant}`}>
      {urls.map((url) => (
        <button key={url} type="button" className="lesson-image-btn" onClick={() => setEnlarged(url)} aria-label="Enlarge picture">
          {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from a private bucket */}
          <img src={url} alt="Picture for the question" />
        </button>
      ))}
      {enlarged && <ImageLightbox url={enlarged} onClose={() => setEnlarged(null)} />}
    </div>
  );
}
