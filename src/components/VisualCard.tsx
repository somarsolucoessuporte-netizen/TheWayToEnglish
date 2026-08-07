"use client";

import { useEffect, useState } from "react";

/** `query` is what /api/image resolves via Wikipedia (see that route);
 * `caption` is shown under the image once it loads — see ChatLog's
 * detectVisualEntity for where both come from (a plain string match
 * against app-config/visual-entities.ts, not a model-generated field). */
export function VisualCard({ query, caption }: { query: string; caption: string }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setImageUrl(null);

    fetch(`/api/image?q=${encodeURIComponent(query)}`)
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
  }, [query]);

  // Wikipedia had nothing (or the lookup failed) — never break the chat
  // over a missing picture, just show nothing.
  if (!imageUrl) return null;

  return (
    <div className="visual-card">
      <img src={imageUrl} alt={caption} className="visual-card-img" />
      <div className="visual-card-caption">{caption}</div>
    </div>
  );
}
