"use client";

import { useEffect, useState } from "react";

/**
 * True below `breakpointPx` (768 by default, matching the voice-first
 * mobile layout vs. the desktop side-by-side one — see page.tsx). Starts
 * false on every render (SSR has no window, and avoiding a hydration
 * mismatch matters more than a one-frame flash of the desktop layout on a
 * phone) and corrects itself in an effect right after mount.
 */
export function useIsMobile(breakpointPx = 768): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [breakpointPx]);

  return isMobile;
}
