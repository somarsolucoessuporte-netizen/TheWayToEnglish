import type { AIOptions, AIProvider, Message } from "./AIProvider";
import { TutorResponseSchema, type TutorResponse } from "./TutorResponse";

/**
 * Client-safe AIProvider: never touches an LLM API key directly. It calls
 * our own /api/chat route, which runs GroqAIProvider server-side. This is
 * the AIProvider the conversation orchestrator uses in the browser.
 */
export class HttpAIProvider implements AIProvider {
  constructor(private readonly endpoint: string = "/api/chat") {}

  async send(messages: Message[], opts?: AIOptions): Promise<TutorResponse> {
    const response = await fetch(this.endpoint, {
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
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Chat HTTP ${response.status}: ${errText.slice(0, 300)}`);
    }

    const data = await response.json();
    return TutorResponseSchema.parse(data);
  }
}
