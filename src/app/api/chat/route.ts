import { NextRequest, NextResponse } from "next/server";
import { GroqAIProvider } from "@/core/ai/GroqAIProvider";
import { OpenAIProvider } from "@/core/ai/OpenAIProvider";
import { TutorResponseSchema } from "@/core/ai/TutorResponse";
import { TUTOR_SYSTEM_PROMPT } from "@/app-config/persona";
import { getCourseOverview, getLessonByCode } from "@/app-config/curriculum";
import type { Message } from "@/core/ai/AIProvider";

// The provider swap lives here, not in app-config/providers.ts: both
// providers hold an API key server-side (GROQ_API_KEY / OPENAI_API_KEY),
// so they must never be imported into client ("use client") code — the
// client always talks to this route through HttpAIProvider instead. Swap
// engines with this one line:
//   Opção A: Groq/Llama (rápido, gratuito)
// const provider = new GroqAIProvider();
//   Opção B: OpenAI GPT (melhor PT/JSON) — ativo agora, mesma
//   OPENAI_API_KEY já usada pelo TTS.
const provider = new OpenAIProvider();

export async function GET() {
  return NextResponse.json({ status: "online", projeto: "the-way-to-english" });
}

interface ChatRequestBody {
  messages?: Message[];
  sessionId?: string;
  detectedLanguage?: string;
  studentName?: string;
  currentLessonCode?: string;
  timeWarning?: boolean;
  attemptCount?: number;
  nudge?: "gentle" | "help" | "offer" | "answer";
  usedNudges?: string[];
}

/** Level-specific instruction for a NUDGE EVENT (see ChatRequestBody.nudge
 * / persona.ts's ACTIVE TUTOR section) — the student has gone quiet for
 * roughly this long, cumulative idle time since the current question was
 * asked (see orchestrator's idle clock). 'answer' is the final resolution:
 * stop waiting and move the lesson forward. */
const NUDGE_INSTRUCTIONS: Record<NonNullable<ChatRequestBody["nudge"]>, string> = {
  gentle:
    "The student has been silent for about 6 seconds. Give a short, warm encouragement in English — they may just need a moment.",
  help: "The student has been silent for about 14 seconds. Reformulate your last question in Portuguese and give a concrete example to help them get started.",
  offer:
    "The student has been silent for about 25 seconds. Offer, in Portuguese, to give them the answer directly so you can practice the pronunciation together.",
  answer:
    "The student has been silent for about 40 seconds total now. Stop waiting: give them the answer directly (English, then a Portuguese cue), and ask them to repeat it after you.",
};

const MAX_NAME_LEN = 80;

export async function POST(req: NextRequest) {
  let body: ChatRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ erro: "corpo inválido" }, { status: 400 });
  }

  const clientMessages = Array.isArray(body.messages) ? body.messages : [];
  // The persona is always injected server-side — a client-sent "system"
  // message (if any) is discarded rather than trusted.
  const conversation = clientMessages.filter((m) => m.role !== "system");

  if (conversation.length === 0) {
    return NextResponse.json({ erro: "nenhuma mensagem enviada" }, { status: 400 });
  }

  const hints: Message[] = [];

  if (body.detectedLanguage) {
    const isPt = body.detectedLanguage.toLowerCase().startsWith("pt");
    const isEn = body.detectedLanguage.toLowerCase().startsWith("en");
    hints.push({
      role: "system",
      content: isPt
        ? "Note: Whisper detected the student's most recent voice message as Portuguese (transcribed by speech recognition — it may contain mishearings). They may be a beginner leaning on Portuguese. Weigh the sandwich method accordingly."
        : isEn
          ? "Note: Whisper detected the student's most recent voice message as English (transcribed by speech recognition — it may contain mishearings, especially with a Brazilian accent)."
          : `Note: Whisper detected the student's most recent voice message as "${body.detectedLanguage}" (transcribed by speech recognition — it may contain mishearings).`,
    });
  }

  if (body.timeWarning) {
    hints.push({
      role: "system",
      content:
        "Note: only about 3 minutes remain in this lesson (see TIME MANAGEMENT). Steer the " +
        "conversation toward a natural wrap-up now — don't start new topics or new vocabulary.",
    });
  }

  if (typeof body.attemptCount === "number" && body.attemptCount > 0) {
    hints.push({
      role: "system",
      content:
        `Note: the student has already failed the current pronunciation/correction target ` +
        `${body.attemptCount} time(s) before this message — this is attempt number ` +
        `${body.attemptCount + 1}. Follow ATTEMPT-BASED CORRECTION ESCALATION.`,
    });
  }

  if (body.nudge) {
    const usedNudges = Array.isArray(body.usedNudges) ? body.usedNudges.filter((n) => typeof n === "string") : [];
    hints.push({
      role: "system",
      content:
        `Note: NUDGE EVENT (${body.nudge}). ${NUDGE_INSTRUCTIONS[body.nudge]} ` +
        (usedNudges.length > 0
          ? `You have already used these encouragements earlier in this session — do NOT repeat any of ` +
            `them verbatim, say something different this time: ${usedNudges.map((n) => `"${n}"`).join("; ")}.`
          : "This is the first nudge this session — no prior encouragement to avoid repeating yet."),
    });
  }

  const studentName = body.studentName?.slice(0, MAX_NAME_LEN).trim();
  const lesson = body.currentLessonCode ? getLessonByCode(body.currentLessonCode) : undefined;

  if (studentName || lesson) {
    const overview = getCourseOverview()
      .map((l) => `${l.lessonCode} — ${l.title}`)
      .join("; ");

    const lessonBlock = lesson
      ? `Current lesson: ${lesson.lessonCode} — ${lesson.title}. ` +
        `Vocabulary: ${lesson.vocabulary.join(", ") || "(none)"}. ` +
        `Grammar points: ${lesson.grammarPoints.join(", ") || "(none)"}. ` +
        `Target phrases: ${lesson.targetPhrases.join(" | ") || "(none)"}. ` +
        `Can-do goals: ${lesson.canDo.join(", ") || "(none)"}.`
      : "Current lesson: unknown — treat this as an open conversation, no specific lesson to teach.";

    hints.push({
      role: "system",
      content:
        `Student name: ${studentName || "unknown"}. ${lessonBlock} ` +
        `Full course overview (for recognizing content from other lessons, not for teaching ahead): ${overview}.`,
    });
  }

  try {
    const response = await provider.send(
      [{ role: "system", content: TUTOR_SYSTEM_PROMPT }, ...hints, ...conversation],
      {
        sessionId: body.sessionId,
        detectedLanguage: body.detectedLanguage,
        studentName,
        currentLessonCode: body.currentLessonCode,
        timeWarning: body.timeWarning,
        attemptCount: body.attemptCount,
        nudge: body.nudge,
        usedNudges: body.usedNudges,
      }
    );
    return NextResponse.json(TutorResponseSchema.parse(response));
  } catch (err) {
    console.error(err);
    return NextResponse.json({ erro: "Erro ao consultar IA" }, { status: 500 });
  }
}
