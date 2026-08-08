"use client";

import { useEffect, useState } from "react";
import { getDebugLogLines, getDebugSteps, subscribeDebug, type DebugStep } from "@/core/debug/debugStore";
import { isIOS } from "@/core/utils/platform";

const STATUS_ICON: Record<DebugStep["status"], string> = {
  ok: "✓",
  pending: "…",
  error: "✗",
  info: "i",
};

function buildFullLogText(steps: DebugStep[], lines: string[]): string {
  const header = [
    `userAgent: ${navigator.userAgent}`,
    `isIOS(): ${String(isIOS())}`,
    `timestamp: ${new Date().toISOString()}`,
  ];
  const checklist = steps.map((s) => `[${STATUS_ICON[s.status]}] ${s.label}\t${s.detail}`);
  return [...header, "", "--- checklist ---", ...checklist, "", "--- log ---", ...lines].join("\n");
}

/**
 * On-screen diagnostics for the iOS splash-freeze investigation — enabled
 * with ?debug=1 in the URL (see debugStore.isDebugEnabled/page.tsx). Only
 * a Mac with a physical iPhone can inspect Safari remotely, and this
 * environment has neither, so the student's own phone has to show its own
 * boot checklist, global errors, and AudioContext state instead of a
 * screenshot going back and forth. Deliberately renders OUTSIDE the
 * bootState-gated part of page.tsx's tree, so it stays up through
 * "timeout"/"error" too, not just once the app is "ready".
 */
export function DebugPanel() {
  // subscribeDebug notifies on every store write — this component doesn't
  // hold its own copy of the data, it just re-reads the store's getters
  // each time and forces a re-render to reflect them.
  const [, setTick] = useState(0);
  useEffect(() => subscribeDebug(() => setTick((n) => n + 1)), []);
  const [copyLabel, setCopyLabel] = useState("Copiar log");

  const steps = getDebugSteps();
  const lines = getDebugLogLines();

  async function handleCopy() {
    const text = buildFullLogText(steps, lines);
    try {
      await navigator.clipboard.writeText(text);
      setCopyLabel("Copiado!");
    } catch {
      setCopyLabel("Falhou — selecione manualmente");
    }
    setTimeout(() => setCopyLabel("Copiar log"), 2000);
  }

  return (
    <div className="debug-panel">
      <div className="debug-panel-header">
        <span>Debug</span>
        <button type="button" className="debug-panel-copy" onClick={handleCopy}>
          {copyLabel}
        </button>
      </div>
      <div className="debug-panel-body">
        <div className="debug-panel-row">userAgent: {navigator.userAgent}</div>
        <div className="debug-panel-row">isIOS(): {String(isIOS())}</div>
        {steps.map((step) => (
          <div key={step.id} className="debug-panel-row">
            [{STATUS_ICON[step.status]}] {step.label} {step.detail}
          </div>
        ))}
        <div className="debug-panel-sep" />
        {lines.length === 0 ? (
          <div className="debug-panel-row debug-panel-muted">(nenhum erro capturado ainda)</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="debug-panel-row">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
