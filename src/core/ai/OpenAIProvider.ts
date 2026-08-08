import type { AIOptions, AIProvider, Message } from "./AIProvider";
import { parseTutorResponse, type TutorResponse } from "./TutorResponse";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

/**
 * Alternative AIProvider (see app-config/providers.ts) — same messages,
 * same system prompt, same TutorResponse schema as GroqAIProvider, just a
 * different backend. Server-only — holds OPENAI_API_KEY, so it must only
 * be instantiated inside app/api/chat/route.ts, never imported from
 * client ("use client") code. Reuses the same OPENAI_API_KEY already
 * configured for OpenAITTSProvider.
 */
export class OpenAIProvider implements AIProvider {
  constructor(
    private readonly apiKey: string | undefined = process.env.OPENAI_API_KEY,
    private readonly model: string = process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini"
  ) {}

  async send(messages: Message[], _opts?: AIOptions): Promise<TutorResponse> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY não configurada");
    }

    const response = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.6,
        // Bounds worst-case latency: generation time is roughly linear in
        // token count, and TutorResponse's JSON shape (a couple of short
        // spoken sentences, up to 3 short hints) never legitimately needs
        // more than this — without a cap, an occasional runaway
        // completion (the model rambling before closing the JSON object)
        // is pure wasted time the student is sitting there for.
        max_tokens: 500,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`OpenAI HTTP ${response.status}: ${errText.slice(0, 300)}`);
    }

    const data = await response.json();
    const raw: string = data?.choices?.[0]?.message?.content ?? "";
    // DIAGNOSTIC LOGGING (temporary — investigating repeated /api/chat
    // failures): the exact text the model returned, before parseTutorResponse
    // does its JSON.parse + Zod validation — parseTutorResponse itself never
    // throws (it has a last-resort fallback branch), so a malformed/leaked
    // response from the model would otherwise degrade silently into a
    // generic fallback reply instead of surfacing anywhere.
    console.log("[chat] resposta crua:", raw);
    return parseTutorResponse(raw);
  }
}
