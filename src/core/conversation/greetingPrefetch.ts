import { aiProvider } from "@/app-config/providers";
import { TUTOR_SYSTEM_PROMPT } from "@/app-config/persona";
import type { DemoStudent } from "@/app-config/demo-students";
import type { Message } from "../ai/AIProvider";
import type { TutorResponse } from "../ai/TutorResponse";
import { LESSON_KICKOFF_INSTRUCTION } from "./orchestrator";

export interface PrefetchedGreeting {
  response: TutorResponse;
  /** The kickoff's English audio, already fetched — undefined if the TTS
   * fetch failed or the greeting had no English part (shouldn't happen in
   * practice, but orchestrator.startLesson falls back to a live speak()
   * either way). */
  audioBlob?: Blob;
}

/**
 * Runs the exact same /api/chat kickoff call orchestrator.startLesson
 * would make for this student, plus a /api/tts fetch for the resulting
 * greeting — called once per demo student, in parallel, during the boot
 * loading screen (see page.tsx's runBoot), so that by the time the
 * student is actually picked, both are already sitting in memory and
 * startLesson can speak instantly instead of waiting on either call.
 * Deliberately NOT part of the boot gate itself (the app shouldn't wait
 * on 3 chat+tts round trips before becoming usable) — this is a
 * best-effort background prefetch that resolves null on any failure,
 * in which case startLesson just falls back to its normal live call.
 */
export async function prefetchGreeting(student: DemoStudent): Promise<PrefetchedGreeting | null> {
  try {
    const messages: Message[] = [
      { role: "system", content: TUTOR_SYSTEM_PROMPT },
      { role: "user", content: LESSON_KICKOFF_INSTRUCTION },
    ];
    const response = await aiProvider.send(messages, {
      studentName: student.name,
      currentLessonCode: student.currentLesson,
    });

    let audioBlob: Blob | undefined;
    const english = response.speech.english.trim();
    if (english) {
      const ttsRes = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: english, speed: 1.0 }),
      });
      if (ttsRes.ok) {
        const buffer = await ttsRes.arrayBuffer();
        audioBlob = new Blob([buffer], { type: "audio/mpeg" });
      }
    }

    return { response, audioBlob };
  } catch (err) {
    console.error(`[greeting-prefetch] falhou para ${student.id}:`, err);
    return null;
  }
}
