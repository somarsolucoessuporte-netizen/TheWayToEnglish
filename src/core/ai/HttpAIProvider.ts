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

  /** See setLesson. */
  private lesson: { id: string; code: string } | undefined;
  /** The item the tutor's last reply asked (TutorResponse.item) — /api/chat
   * checks the student's answer against that item's expected answer. */
  private lastItem: string | undefined;

  /** The lesson being taught, by id: lesson codes repeat across units
   * (Book 2 / Unit 1 has a 1A too), and the orchestrator only carries the
   * code. Sent with every request whose currentLessonCode is that code. */
  setLesson(lesson: { id: string; code: string } | undefined): void {
    this.lesson = lesson;
    this.lastItem = undefined;
  }

  async send(messages: Message[], opts?: AIOptions): Promise<TutorResponse> {
    const lesson =
      this.lesson && opts?.currentLessonCode?.toLowerCase() === this.lesson.code.toLowerCase() ? this.lesson : undefined;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    const onExternalAbort = () => controller.abort();
    opts?.signal?.addEventListener("abort", onExternalAbort);

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
          lessonId: lesson?.id,
          currentItemId: lesson ? this.lastItem : undefined,
          timeWarning: opts?.timeWarning,
          attemptCount: opts?.attemptCount,
          nudge: opts?.nudge,
          usedNudges: opts?.usedNudges,
          completedGoals: opts?.completedGoals,
          currentTaskId: opts?.currentTaskId,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (opts?.signal?.aborted) throw new Error("Chat interrompido pelo aluno");
      if ((err as Error).name === "AbortError") {
        throw new Error("Chat timeout: /api/chat não respondeu a tempo");
      }
      throw err;
    } finally {
      window.clearTimeout(timeoutId);
      opts?.signal?.removeEventListener("abort", onExternalAbort);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Chat HTTP ${response.status}: ${errText.slice(0, 300)}`);
    }

    const data = TutorResponseSchema.parse(await response.json());
    if (lesson && lesson === this.lesson) this.lastItem = data.item;
    return data;
  }
}
