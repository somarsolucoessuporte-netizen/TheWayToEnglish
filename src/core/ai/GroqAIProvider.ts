import type { AIOptions, AIProvider, Message } from "./AIProvider";
import { parseTutorResponse, type TutorResponse } from "./TutorResponse";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Default AIProvider. Server-only — holds GROQ_API_KEY, so it must only be
 * instantiated inside app/api/chat/route.ts, never imported from
 * client ("use client") code. The browser talks to HttpAIProvider instead,
 * which calls that route.
 */
export class GroqAIProvider implements AIProvider {
  constructor(
    private readonly apiKey: string | undefined = process.env.GROQ_API_KEY,
    private readonly model: string = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile"
  ) {}

  async send(messages: Message[], _opts?: AIOptions): Promise<TutorResponse> {
    if (!this.apiKey) {
      throw new Error("GROQ_API_KEY não configurada");
    }

    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.6,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Groq HTTP ${response.status}: ${errText.slice(0, 300)}`);
    }

    const data = await response.json();
    const raw: string = data?.choices?.[0]?.message?.content ?? "";
    return parseTutorResponse(raw);
  }
}
