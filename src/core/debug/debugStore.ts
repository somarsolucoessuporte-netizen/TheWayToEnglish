/**
 * On-screen debug overlay (see components/DebugPanel.tsx), enabled with
 * ?debug=1 in the URL — exists because the iOS splash-freeze reports
 * couldn't be reproduced/inspected from this environment (no Mac, no
 * remote Safari inspector), so the student's own iPhone has to show its
 * own diagnostics instead of a screenshot going back and forth.
 *
 * Plain module-level singleton, not React state: the boot sequence (see
 * page.tsx's runBoot) and the global error listeners below both write to
 * this from outside any component's render, and DebugPanel just
 * subscribes to be notified when to re-read it. Capture (steps + global
 * errors) runs unconditionally and is nearly free (a few array pushes
 * capped at MAX_LOG_LINES) — only the PANEL's visibility is gated on
 * ?debug=1, so a report can still include whatever happened just before
 * the student thought to add the query param... except that's not
 * possible here since the param has to be in the URL from page load. It's
 * unconditional anyway because there's no meaningful cost to skip.
 */

export type DebugStatus = "pending" | "ok" | "error";

export interface DebugStep {
  id: string;
  label: string;
  status: DebugStatus;
  detail: string;
}

const MAX_LOG_LINES = 300;

const steps = new Map<string, DebugStep>();
const logLines: string[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) cb();
}

export function isDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("debug") === "1";
}

/** Upserts one row of the boot checklist (see DebugPanel) — `id` is the
 * stable key (e.g. "video:idle"), `label` is what's shown before the
 * detail text (e.g. "idle.mp4"). */
export function setDebugStep(id: string, label: string, status: DebugStatus, detail = ""): void {
  steps.set(id, { id, label, status, detail });
  notify();
}

export function debugLog(line: string): void {
  const stamp = new Date().toISOString().slice(11, 23);
  logLines.push(`[${stamp}] ${line}`);
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
  notify();
}

/** Shared formatting for anything caught off a rejected promise (play(),
 * fetch, etc.) — used both by DebugPanel-adjacent call sites (Avatar.tsx,
 * page.tsx) so error text reads consistently across the log. */
export function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export function getDebugSteps(): DebugStep[] {
  return Array.from(steps.values());
}

export function getDebugLogLines(): string[] {
  return logLines;
}

export function subscribeDebug(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

let captureInitialized = false;

/** Wires window-level "error"/"unhandledrejection" capture into the log
 * above — call once at app startup (see page.tsx). Safe to call more than
 * once; only the first call actually attaches listeners. */
export function initGlobalErrorCapture(): void {
  if (captureInitialized || typeof window === "undefined") return;
  captureInitialized = true;
  window.addEventListener("error", (e) => {
    debugLog(`window.error: ${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason as unknown;
    const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    debugLog(`unhandledrejection: ${text}`);
  });
}
