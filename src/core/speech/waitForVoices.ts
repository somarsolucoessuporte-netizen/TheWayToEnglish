/**
 * Resolves once speechSynthesis reports at least one voice, or after
 * `timeoutMs`, whichever comes first — some browsers (notably Chrome) load
 * voices asynchronously and briefly report an empty list right after page
 * load. Used by the app's boot loading gate (see app/page.tsx) alongside
 * the user-gesture warm-up in handleStudentPick — both exist because
 * speechSynthesis needs to be ready even though OpenAITTSProvider, not
 * WebSpeechProvider, is the active SpeechProvider. Resolves immediately
 * when speechSynthesis isn't supported at all.
 */
export function waitForVoices(timeoutMs = 2000): Promise<void> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return Promise.resolve();
  }
  if (window.speechSynthesis.getVoices().length > 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.speechSynthesis.removeEventListener("voiceschanged", finish);
      resolve();
    };
    window.speechSynthesis.addEventListener("voiceschanged", finish);
    window.setTimeout(finish, timeoutMs);
  });
}
