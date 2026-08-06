import type { SpeechProvider } from "@/core/speech/SpeechProvider";
import { WebSpeechProvider } from "@/core/speech/WebSpeechProvider";
// import { ElevenLabsSpeechProvider } from "@/core/speech/ElevenLabsSpeechProvider";

import type { SpeechToTextProvider } from "@/core/stt/SpeechToTextProvider";
import { BrowserSTTProvider } from "@/core/stt/BrowserSTTProvider";
import { WhisperSTTProvider } from "@/core/stt/WhisperSTTProvider";

import type { AIProvider } from "@/core/ai/AIProvider";
import { HttpAIProvider } from "@/core/ai/HttpAIProvider";

/**
 * The one place that decides which concrete implementation backs each
 * core/ interface for this app. Swapping the voice engine, for example,
 * is exactly this one line:
 *
 *   export const speechProvider: SpeechProvider = new ElevenLabsSpeechProvider();
 */
export const speechProvider: SpeechProvider = new WebSpeechProvider();

// Whisper (Groq) is the default STT — better accuracy for Brazilian-accented
// English than the browser's native recognizer, plus works in more browsers.
// BrowserSTTProvider is kept for comparison; swap back with this one line:
export const sttProvider: SpeechToTextProvider = new WhisperSTTProvider();
// export const sttProvider: SpeechToTextProvider = new BrowserSTTProvider("en-US");

export const aiProvider: AIProvider = new HttpAIProvider();
