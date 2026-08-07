import type { AIOptions, AIProvider, Message } from "./AIProvider";
import { TutorResponseSchema, type TutorResponse } from "./TutorResponse";

/** Without this, a stalled /api/chat request (bad 4G, a hung serverless
 * function) never resolves OR rejects — fetch() has no default timeout —
 * which leaves orchestrator.busy stuck true forever and the Falar button
 * permanently dead with zero feedback. This is the single highest-value
 * fix for that class of freeze: it guarantees send() always eventually
 * settles one way or the other. */
const CHAT_TIMEOUT_MS = 15000;

/**
 * Client-safe AIProvider: never touches an LLM API key directly. It calls
 * our own /api/chat route, which runs GroqAIProvider server-side. This is
 * the AIProvider the conversation orchestrator uses in the browser.
 */
export class HttpAIProvider implements AIProvider {
  constructor(private readonly endpoint: string = "/api/chat") {}

  async send(messages: Message[], opts?: AIOptions): Promise<TutorResponse> {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          sessionId: opts?.sessionId,
          detectedLanguage: opts?.detectedLanguage,
          studentName: opts?.studentName,
          currentLessonCode: opts?.currentLessonCode,
          timeWarning: opts?.timeWarning,
          attemptCount: opts?.attemptCount,
          nudge: opts?.nudge,
          usedNudges: opts?.usedNudges,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error("Chat timeout: /api/chat não respondeu a tempo");
      }
      throw err;
    } finally {
      window.clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Chat HTTP ${response.status}: ${errText.slice(0, 300)}`);
    }

    const data = await response.json();
    return TutorResponseSchema.parse(data);
  }
}
