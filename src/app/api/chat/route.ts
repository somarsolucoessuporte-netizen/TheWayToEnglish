import { NextRequest, NextResponse } from "next/server";
import { GroqAIProvider } from "@/core/ai/GroqAIProvider";
import { TutorResponseSchema } from "@/core/ai/TutorResponse";
import { TUTOR_SYSTEM_PROMPT } from "@/app-config/persona";
import { getCourseOverview, getLessonByCode } from "@/app-config/curriculum";
import type { Message } from "@/core/ai/AIProvider";

const provider = new GroqAIProvider();

export async function GET() {
  return NextResponse.json({ status: "online", projeto: "the-way-to-english" });
}

interface ChatRequestBody {
  messages?: Message[];
  sessionId?: string;
  detectedLanguage?: string;
  studentName?: string;
  currentLessonCode?: string;
}

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
      }
    );
    return NextResponse.json(TutorResponseSchema.parse(response));
  } catch (err) {
    console.error(err);
    return NextResponse.json({ erro: "Erro ao consultar IA" }, { status: 500 });
  }
}
