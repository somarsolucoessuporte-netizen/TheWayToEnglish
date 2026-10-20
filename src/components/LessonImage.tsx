"use client";

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

/** Large picture next to the question — over the avatar on desktop
 * (variant "stage"), under the floating header on mobile. Nothing is
 * rendered without a picture. The alt text never says what the picture
 * shows: that is the student's answer. */
export function LessonImage({ urls, variant }: { urls: string[] | null; variant: "stage" | "mobile" }) {
  if (!urls || urls.length === 0) return null;
  return (
    <div className={`lesson-image lesson-image--${variant}`}>
      {urls.map((url) => (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from a private bucket
        <img key={url} src={url} alt="Picture for the question" />
      ))}
    </div>
  );
}
