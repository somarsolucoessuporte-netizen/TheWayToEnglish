"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatEntry } from "@/core/conversation/orchestrator";

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
 * any click, the × button or Esc. */
function ImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="lesson-image-lightbox" role="dialog" aria-label="Picture, enlarged" onClick={onClose}>
      <button type="button" className="lesson-image-close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from a private bucket */}
      <img src={url} alt="Picture for the question" />
    </div>,
    document.body
  );
}

/** The one and only way a lesson picture is shown (student chat, mobile
 * drawer and /admin preview): a fixed 4:3 frame inside the flow of its
 * container — never floating. Space is reserved before load (no layout
 * jump); `onLoaded` lets the chat scroll to the end once the picture has its
 * real height. Tap to enlarge. The alt text never says what the picture
 * shows: that is the student's answer. */
export function LessonImage({ urls, onLoaded }: { urls: string[] | null; onLoaded?: () => void }) {
  const [enlarged, setEnlarged] = useState<string | null>(null);
  if (!urls || urls.length === 0) return null;
  return (
    <div className="lesson-image">
      {urls.map((url) => (
        <button key={url} type="button" className="lesson-image-btn" onClick={() => setEnlarged(url)} aria-label="Enlarge picture">
          {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from a private bucket */}
          <img src={url} alt="Picture for the question" onLoad={onLoaded} onError={onLoaded} />
        </button>
      ))}
      {enlarged && <ImageLightbox url={enlarged} onClose={() => setEnlarged(null)} />}
    </div>
  );
}
