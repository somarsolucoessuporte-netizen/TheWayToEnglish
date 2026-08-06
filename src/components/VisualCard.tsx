"use client";

import { useEffect, useState } from "react";
import type { TutorResponse } from "@/core/ai/TutorResponse";

export function VisualCard({ visual }: { visual: NonNullable<TutorResponse["visual"]> }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setImageUrl(null);

    fetch(`/api/image?q=${encodeURIComponent(visual.query)}`)
      .then((res) => (res.ok ? res.json() : { imageUrl: null }))
      .then((data: { imageUrl: string | null }) => {
        if (!cancelled) setImageUrl(data.imageUrl);
      })
      .catch(() => {
        if (!cancelled) setImageUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [visual.query]);

  // Wikipedia had nothing (or the lookup failed) — never break the chat
  // over a missing picture, just show nothing.
  if (!imageUrl) return null;

  return (
    <div className="visual-card">
      <img src={imageUrl} alt={visual.caption} className="visual-card-img" />
      <div className="visual-card-caption">{visual.caption}</div>
    </div>
  );
}
