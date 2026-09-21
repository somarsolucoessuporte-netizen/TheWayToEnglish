import { NextRequest, NextResponse } from "next/server";
import { GroqAIProvider } from "@/core/ai/GroqAIProvider";
import { OpenAIProvider } from "@/core/ai/OpenAIProvider";
import { TutorResponseSchema, type TutorResponse } from "@/core/ai/TutorResponse";
import { TUTOR_SYSTEM_PROMPT } from "@/app-config/persona";
import { getCourseOverview, getFirstLesson, getGlobalPrinciples, getLessonByCode, taskId, type CurriculumLesson } from "@/app-config/curriculum";
import type { AIOptions, Message } from "@/core/ai/AIProvider";
import { introductionReply } from "@/core/conversation/introductionReply";

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
  /** Alias accepted for currentLessonCode — the school platform's real
   * integration (see the ?aluno=&licao= URL contract in page.tsx) may not
   * know our internal field name; either spelling resolves the same lesson. */
  lessonCode?: string;
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
    "The student has been silent for about 6 seconds. Do NOT ask a generic question or give vague " +
    "encouragement — look at your own last message in the conversation and REPEAT that exact instruction " +
    "in English, so the student knows precisely what to do (e.g. \"Let's try again. Repeat after me: READING.\").",
  help: "The student has been silent for about 14 seconds. Reformulate your last question in Portuguese and give a concrete example to help them get started.",
  offer:
    "The student has been silent for about 25 seconds. Offer, in Portuguese, to give them the answer directly so you can practice the pronunciation together.",
  answer:
    "The student has been silent for about 40 seconds total now. Stop waiting: give them the answer directly (English, then a Portuguese cue), and ask them to repeat it after you.",
};

const MAX_NAME_LEN = 80;

/**
 * Renders the current lesson's full roteiro (global principles + ordered
 * task sequence + reference content) as the "CURRENT LESSON PLAN" block
 * injected into the system prompt — this is what lets the tutor actually
 * follow the school's real lesson script instead of improvising, and is
 * shared verbatim by both a normal turn and the lesson-kickoff turn (see
 * orchestrator.startLesson / greetingPrefetch.ts — both just set
 * currentLessonCode and land here through the same code path).
 *
 * There's no separate wire field carrying "which task is currently in
 * progress" (that would mean orchestrator.ts forwarding completed task
 * ids on every request — out of scope for this change, see the task-id
 * bracket note below). Instead the instruction block asks the model to
 * infer the current task from the conversation history it already
 * receives in full every turn, the same way completedGoals matching
 * already works.
 */
function buildLessonPlanBlock(lesson: CurriculumLesson, principles: string[]): string {
  const lines: string[] = ["CURRENT LESSON PLAN", "", `Book: ${lesson.book} | Lesson: ${lesson.code} — ${lesson.title}`, ""];

  if (principles.length > 0) {
    lines.push("GLOBAL PRINCIPLES (always apply):");
    for (const p of principles) lines.push(`- ${p}`);
    lines.push("");
  }

  if (lesson.tasks.length > 0) {
    lines.push("YOUR TASK SEQUENCE FOR THIS SESSION:");
    for (const t of lesson.tasks) {
      lines.push(`${t.order}. [${taskId(t.order)}] ${t.instruction} (type: ${t.type})`);
    }
    lines.push("");
  }

  if (lesson.practiceNote) {
    lines.push(`Practice note: ${lesson.practiceNote}`, "");
  }

  const ref = lesson.referenceContent;
  const hasReference =
    ref.dialogues.length > 0 ||
    ref.vocabulary.length > 0 ||
    (ref.grammarNotes?.length ?? 0) > 0 ||
    (ref.tables?.length ?? 0) > 0 ||
    (ref.practicePhrases?.length ?? 0) > 0;

  if (hasReference) {
    lines.push("REFERENCE CONTENT:");
    if (ref.dialogues.length > 0) {
      lines.push("Dialogues:");
      for (const dialogue of ref.dialogues) {
        for (const line of dialogue) lines.push(`- ${line}`);
      }
    }
    if (ref.vocabulary.length > 0) {
      lines.push(`Vocabulary: ${ref.vocabulary.join(", ")}`);
    }
    if (ref.grammarNotes && ref.grammarNotes.length > 0) {
      lines.push("Grammar notes:");
      for (const note of ref.grammarNotes) lines.push(`- ${note}`);
    }
    if (ref.tables && ref.tables.length > 0) {
      lines.push("Tables:");
      for (const table of ref.tables) {
        if (table.caption) lines.push(`(${table.caption})`);
        for (const row of table.rows) {
          const cells = row.filter((c) => c.trim());
          if (cells.length > 0) lines.push(`- ${cells.join(" | ")}`);
        }
      }
    }
    if (ref.practicePhrases && ref.practicePhrases.length > 0) {
      lines.push("Practice phrases:");
      for (const group of ref.practicePhrases) {
        lines.push(`${group.group}: ${group.phrases.join("; ")}`);
      }
    }
    lines.push("");
  }

  if (lesson.requiresImages && lesson.imageNote) {
    lines.push(`Image note: ${lesson.imageNote}`, "");
  }

  lines.push(
    "IMPORTANT: execute tasks IN ORDER. Use the conversation so far to tell which task is current — " +
      "skip any task whose bracketed id (e.g. \"task-3\") you already reported in a prior completedGoals, " +
      "and continue from the next one. Start with task 1 immediately after the opening greeting and lesson " +
      "announcement. Do not ask the student what they want to practice — you lead the session. When a task " +
      "is genuinely finished, include its bracketed id in completedGoals."
  );

  return lines.join("\n");
}

/** Strips accents and normalizes case/whitespace for a loose but reliable
 * substring comparison — see findLeakedAnswer. */
function normalizeForComparison(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // strip diacritics (combining marks left after NFD)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Defense in depth for persona.ts's ASKING VS. HELPING rule: even with
 * explicit prompt instructions, a small model still sometimes answers its
 * own question inside `speech`. This mechanically checks speech.english +
 * speech.portuguese for any of expectedAnswer.values (case/accent-
 * insensitive substring match) and returns the specific value found
 * leaked, or null if clean. Only meaningful when the turn actually
 * declared a checkable "enum" expectedAnswer — a "free" or missing one
 * has nothing fixed to check against.
 */
function findLeakedAnswer(response: TutorResponse): string | null {
  const expected = response.expectedAnswer;
  if (!expected || expected.type !== "enum" || !expected.values?.length) return null;

  const spoken = normalizeForComparison(`${response.speech.english} ${response.speech.portuguese}`);
  for (const value of expected.values) {
    const normalizedValue = normalizeForComparison(value);
    if (normalizedValue && spoken.includes(normalizedValue)) return value;
  }
  return null;
}

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
  const requestedLessonCode = body.currentLessonCode ?? body.lessonCode;
  console.log("[4 api] body.lessonCode:", requestedLessonCode);

  // GARANTIA: the tutor must NEVER run a session with no roteiro — if the
  // requested code doesn't resolve (missing, typo'd, stale demo data, a
  // curriculum JSON that doesn't have it), fall back to the course's first
  // lesson rather than letting the model drift into open/free conversation
  // (see persona.ts's STRICT RULES FROM THE SCHOOL — it must always be led
  // by a lesson plan). This was the actual production bug: the old fallback
  // told the model to "treat this as an open conversation" whenever
  // getLessonByCode() came back empty.
  let lesson = requestedLessonCode ? getLessonByCode(requestedLessonCode) : undefined;
  if (!lesson) {
    lesson = getFirstLesson();
    console.error(
      "[chat] LIÇÃO NÃO ENCONTRADA para código:",
      requestedLessonCode ?? "(nenhum enviado)",
      "— usando fallback",
      lesson.code
    );
  }
  console.log("[5 api] lição encontrada:", lesson.code);
  console.log("[6 api] tasks:", lesson.tasks?.length);

  if (studentName) {
    hints.push({ role: "system", content: `Student name: ${studentName}.` });
  }

  const lessonPlanBlock = buildLessonPlanBlock(lesson, getGlobalPrinciples());
  console.log("[7 api] plano injetado:", lessonPlanBlock.slice(0, 200));
  hints.push({ role: "system", content: lessonPlanBlock });
  const overview = getCourseOverview()
    .map((l) => `${l.lessonCode} — ${l.title}`)
    .join("; ");
  hints.push({
    role: "system",
    content: `Full course overview (for recognizing content from other lessons, not for teaching ahead): ${overview}.`,
  });

  try {
    const introduction = !body.nudge ? introductionReply(lesson.code, conversation) : undefined;
    if (introduction) return NextResponse.json(introduction);
    const messages: Message[] = [{ role: "system", content: TUTOR_SYSTEM_PROMPT }, ...hints, ...conversation];
    const sendOptions: AIOptions = {
      sessionId: body.sessionId,
      detectedLanguage: body.detectedLanguage,
      studentName,
      currentLessonCode: requestedLessonCode,
      timeWarning: body.timeWarning,
      attemptCount: body.attemptCount,
      nudge: body.nudge,
      usedNudges: body.usedNudges,
    };

    let response = TutorResponseSchema.parse(await provider.send(messages, sendOptions));

    // Server-side guard (defense in depth for persona.ts's ASKING VS.
    // HELPING rule) — even with explicit prompt instructions, a small
    // model still sometimes answers its own question inside `speech`.
    // One retry with a reinforced instruction, never more: this must
    // never become an unbounded loop on a model that keeps leaking.
    const leaked = findLeakedAnswer(response);
    if (leaked) {
      console.error(`[chat] "speech" vazou a resposta esperada ("${leaked}") — regenerando o turno`);
      const reinforcedMessages: Message[] = [
        ...messages,
        {
          role: "system",
          content:
            `Your previous reply said "${leaked}" inside speech, but that is the answer to the question ` +
            `you were asking — ASKING VS. HELPING forbids this. Regenerate this turn: speech must contain ` +
            `ONLY the question itself, nothing that reveals or hints at the answer. Any help belongs in ` +
            `"hints" instead, not in speech.`,
        },
      ];
      const retryResponse = TutorResponseSchema.parse(await provider.send(reinforcedMessages, sendOptions));
      if (findLeakedAnswer(retryResponse)) {
        console.error('[chat] segunda tentativa ainda vazou a resposta — usando mesmo assim (sem 3a tentativa)');
      }
      response = retryResponse;
    }

    return NextResponse.json(response);
  } catch (err) {
    // DIAGNOSTIC LOGGING (temporary — investigating repeated /api/chat
    // failures): err is `unknown` by default in a catch block, so this
    // narrows just enough to read the fields without a TS error — most
    // errors thrown in this file/OpenAIProvider are plain `Error`s with no
    // real .status/.code, so those will legitimately log as undefined;
    // that itself is useful signal (rules out a structured API error).
    const detail = err as { message?: string; status?: number; code?: string } | undefined;
    console.error("[chat] erro detalhado:", detail?.message, detail?.status, detail?.code);
    console.error(err);
    return NextResponse.json({ erro: "Erro ao consultar IA" }, { status: 500 });
  }
}
