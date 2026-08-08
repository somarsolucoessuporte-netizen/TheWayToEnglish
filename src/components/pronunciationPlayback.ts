import { speechProvider } from "@/app-config/providers";

/**
 * Click handlers shared by CorrectionCard (desktop) and MiniCorrectionCard
 * (mobile) for the Ouvir / Devagar buttons — kept in one place so
 * the "fall back to normal speed if the provider has no real speakSlow"
 * logic (SpeechProvider.speakSlow is optional) only lives once.
 */
export function pronunciationHandlers(word: string): { speakNormal: () => void; speakSlow: () => void } {
  return {
    speakNormal: () => void speechProvider.speak(word, { lang: "en-US" }),
    speakSlow: () =>
      void (speechProvider.speakSlow
        ? speechProvider.speakSlow(word, { lang: "en-US" })
        : speechProvider.speak(word, { lang: "en-US" })),
  };
}
