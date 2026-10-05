"use server";

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase";
import { LESSON_IMAGES_BUCKET, LESSON_STATUSES, getLessonById, lessonImageFolder } from "@/lib/admin/data";
import { DOCX_LESSON_FIELDS, planLessonMerge, type DocxLesson } from "@/lib/admin/mergeLessons";

// NO AUTHENTICATION (by request, for now): anyone who can reach /admin can
// run these. Every input is still validated, and identity/ownership is
// always re-read from the database, never trusted from the form.

export interface ActionResult {
  ok: boolean;
  message: string;
  details?: string[];
}

const fail = (message: string, details?: string[]): ActionResult => ({ ok: false, message, details });

const execFileAsync = promisify(execFile);
const MAX_DOCX_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

const uuid = z.string().uuid();

// ------------------------------------------------------------ .docx import --

const DocxUnitSchema = z.object({
  book: z.string().nullable(),
  unit: z.string().nullable(),
  unitTheme: z.string().nullable().optional(),
  globalPrinciples: z.array(z.string()).optional(),
  lessons: z.array(
    z.object({
      code: z.string().min(1),
      title: z.string().nullable(),
      skill: z.string().nullable(),
      order: z.number().int(),
      practiceNote: z.string().optional(),
      tasks: z.array(z.unknown()),
      referenceContent: z.unknown(),
      requiresImages: z.boolean(),
      imageNote: z.string().optional(),
    })
  ),
});

/** Runs scripts/processar-unit.py on an uploaded .docx and merges the result
 * into the unit — see lib/admin/mergeLessons.ts for what is (not) overwritten.
 * Needs Python + python-docx on the server: works on a local `next dev` /
 * `next start`, not on Vercel's Node runtime. */
export async function importDocx(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const unitId = uuid.safeParse(formData.get("unitId"));
  const file = formData.get("file");
  if (!unitId.success) return fail("Unit inválida.");
  if (!(file instanceof File) || file.size === 0) return fail("Escolha um arquivo .docx.");
  if (!file.name.toLowerCase().endsWith(".docx")) return fail("O arquivo precisa ser .docx.");
  if (file.size > MAX_DOCX_BYTES) return fail("Arquivo grande demais (máx. 15 MB).");

  const supabase = createServiceClient();
  const { data: unit, error: unitError } = await supabase
    .from("units")
    .select("id, code, title, book:books!inner(code, title)")
    .eq("id", unitId.data)
    .maybeSingle();
  if (unitError) return fail(`Erro ao ler a unit: ${unitError.message}`);
  if (!unit) return fail("Unit não encontrada.");
  const book = unit.book as unknown as { code: string; title: string };

  // processar-unit.py takes book/unit from the file name, so the upload is
  // saved under the unit's canonical name regardless of what it was called.
  const dir = await mkdtemp(path.join(tmpdir(), "twte-docx-"));
  const docxPath = path.join(dir, `${book.code}-${unit.code}.docx`);
  const jsonPath = path.join(dir, "unit.json");
  let parsed: z.infer<typeof DocxUnitSchema>;
  try {
    await writeFile(docxPath, Buffer.from(await file.arrayBuffer()));
    const python = process.env.PYTHON_BIN || "python";
    try {
      await execFileAsync(python, [path.join(process.cwd(), "scripts", "processar-unit.py"), docxPath, "--out", jsonPath], {
        timeout: 120_000,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.trim().split("\n").slice(-5) ?? [];
      return fail("processar-unit.py falhou (o servidor tem Python com python-docx?).", stderr);
    }
    const result = DocxUnitSchema.safeParse(JSON.parse(await readFile(jsonPath, "utf8")));
    if (!result.success) return fail("O JSON gerado não tem o formato esperado.", result.error.issues.map((i) => i.message));
    parsed = result.data;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  if (parsed.book !== book.title || parsed.unit !== (unit.title ?? parsed.unit)) {
    return fail(`O .docx foi lido como ${parsed.book} / ${parsed.unit}, mas a unit é ${book.title} / ${unit.title}.`);
  }
  if (parsed.lessons.length === 0) return fail("Nenhuma lição encontrada no .docx — nada foi alterado.");

  const { error: unitUpdateError } = await supabase
    .from("units")
    .update({ theme: parsed.unitTheme ?? null, global_principles: parsed.globalPrinciples ?? [] })
    .eq("id", unit.id);
  if (unitUpdateError) return fail(`Erro ao atualizar a unit: ${unitUpdateError.message}`);

  const { data: existing, error: existingError } = await supabase
    .from("lessons")
    .select("id, code, edited_fields")
    .eq("unit_id", unit.id);
  if (existingError) return fail(`Erro ao ler as lições: ${existingError.message}`);

  const plan = planLessonMerge(existing ?? [], parsed.lessons as DocxLesson[]);

  if (plan.inserts.length > 0) {
    const { error } = await supabase.from("lessons").insert(plan.inserts.map((l) => ({ ...l, unit_id: unit.id })));
    if (error) return fail(`Erro ao inserir lições novas: ${error.message}`);
  }
  for (const update of plan.updates) {
    const { error } = await supabase.from("lessons").update(update.values).eq("id", update.id);
    if (error) return fail(`Erro ao atualizar a lição ${update.code}: ${error.message}`);
  }

  revalidatePath("/admin");
  const details = [
    `${plan.updates.length} lições atualizadas, ${plan.inserts.length} novas (status pendente).`,
    ...(plan.inserts.length ? [`Novas: ${plan.inserts.map((l) => l.code).join(", ")}`] : []),
    ...plan.updates
      .filter((u) => u.protectedFields.length > 0)
      .map((u) => `${u.code}: mantidos (editados à mão) — ${u.protectedFields.join(", ")}`),
    ...(plan.missingFromDocx.length
      ? [`No banco mas não no .docx (não mexi): ${plan.missingFromDocx.join(", ")}`]
      : []),
  ];
  return { ok: true, message: `${book.title} / ${unit.title}: importação concluída.`, details };
}

// ------------------------------------------------------------ lesson edit --

const TaskSchema = z.object({
  order: z.number().int(),
  instruction: z.string(),
  type: z.string(),
  imageDependency: z.enum(["oral", "visual", "image-only"]).optional(),
});

const EDITABLE_FIELDS = ["title", "status", "practice_note", "legacy_tasks", "requires_images", "image_note"] as const;

function optionalText(value: FormDataEntryValue | null): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? null : text;
}

/** Saves the edit form. Only fields whose value actually changed are written,
 * and each of them is added to edited_fields so a later .docx import keeps it. */
export async function saveLesson(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const lessonId = uuid.safeParse(formData.get("lessonId"));
  if (!lessonId.success) return fail("Lição inválida.");
  const current = await getLessonById(lessonId.data);
  if (!current) return fail("Lição não encontrada.");

  const status = formData.get("status");
  if (!LESSON_STATUSES.includes(status as never)) return fail("Status inválido.");

  let tasks: unknown;
  try {
    tasks = JSON.parse(String(formData.get("legacy_tasks") ?? "[]"));
  } catch (err) {
    return fail("legacy_tasks não é um JSON válido.", [(err as Error).message]);
  }
  const tasksResult = z.array(TaskSchema).safeParse(tasks);
  if (!tasksResult.success) {
    return fail(
      "legacy_tasks precisa ser uma lista de { order, instruction, type, imageDependency? }.",
      tasksResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
    );
  }

  const next = {
    title: optionalText(formData.get("title")),
    status,
    practice_note: optionalText(formData.get("practice_note")),
    legacy_tasks: tasks, // as typed (zod would drop unknown keys)
    requires_images: formData.get("requires_images") === "on",
    image_note: optionalText(formData.get("image_note")),
  };
  const changed = EDITABLE_FIELDS.filter((f) => !isDeepStrictEqual(next[f], current[f] ?? (f === "legacy_tasks" ? [] : null)));
  if (changed.length === 0) return { ok: true, message: "Nada mudou — nada foi gravado." };

  const update: Record<string, unknown> = Object.fromEntries(changed.map((f) => [f, next[f]]));
  update.edited_fields = Array.from(new Set([...(current.edited_fields ?? []), ...changed]));
  const { error } = await createServiceClient().from("lessons").update(update).eq("id", current.id);
  if (error) return fail(`Erro ao salvar: ${error.message}`);

  revalidatePath("/admin");
  revalidatePath(`/admin/licao/${encodeURIComponent(current.code)}`);
  return { ok: true, message: `Salvo: ${changed.join(", ")} (marcados como editados à mão).` };
}

/** Removes a field from edited_fields — the next .docx import overwrites it again. */
export async function releaseField(formData: FormData): Promise<void> {
  const lessonId = uuid.safeParse(formData.get("lessonId"));
  const field = String(formData.get("field") ?? "");
  if (!lessonId.success || !(DOCX_LESSON_FIELDS as readonly string[]).concat("status").includes(field)) return;
  const current = await getLessonById(lessonId.data);
  if (!current) return;
  const { error } = await createServiceClient()
    .from("lessons")
    .update({ edited_fields: (current.edited_fields ?? []).filter((f) => f !== field) })
    .eq("id", current.id);
  if (error) throw error;
  revalidatePath("/admin");
  revalidatePath(`/admin/licao/${encodeURIComponent(current.code)}`);
}

// ----------------------------------------------------------- image upload --

/** Uploads an image to lesson-images/<book>/<unit>/<lesson>/ and, when a step
 * is chosen, stores the path in steps.image_path (marking the step as edited
 * by hand). */
export async function uploadLessonImage(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const lessonId = uuid.safeParse(formData.get("lessonId"));
  const stepIdRaw = String(formData.get("stepId") ?? "");
  const file = formData.get("file");
  if (!lessonId.success) return fail("Lição inválida.");
  if (!(file instanceof File) || file.size === 0) return fail("Escolha uma imagem.");
  const extension = IMAGE_TYPES[file.type];
  if (!extension) return fail("Formato não aceito (PNG, JPG, WEBP, GIF ou SVG).");
  if (file.size > MAX_IMAGE_BYTES) return fail("Imagem grande demais (máx. 8 MB).");

  const lesson = await getLessonById(lessonId.data);
  if (!lesson) return fail("Lição não encontrada.");

  const supabase = createServiceClient();
  let stepId: string | null = null;
  if (stepIdRaw) {
    const parsedStep = uuid.safeParse(stepIdRaw);
    if (!parsedStep.success) return fail("Step inválido.");
    const { data: step } = await supabase.from("steps").select("id").eq("id", parsedStep.data).eq("lesson_id", lesson.id).maybeSingle();
    if (!step) return fail("Esse step não pertence a esta lição.");
    stepId = step.id;
  }

  const base = path.parse(file.name).name.normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "imagem";
  const storagePath = `${lessonImageFolder(lesson)}/${Date.now()}-${base}.${extension}`;
  const { error: uploadError } = await supabase.storage
    .from(LESSON_IMAGES_BUCKET)
    .upload(storagePath, Buffer.from(await file.arrayBuffer()), { contentType: file.type, upsert: false });
  if (uploadError) return fail(`Erro no upload: ${uploadError.message}`);

  if (stepId) {
    const { error } = await supabase.from("steps").update({ image_path: storagePath, edited_manually: true }).eq("id", stepId);
    if (error) return fail(`Imagem salva em ${storagePath}, mas o step não foi atualizado: ${error.message}`);
  }

  revalidatePath(`/admin/licao/${encodeURIComponent(lesson.code)}`);
  return {
    ok: true,
    message: stepId ? `Imagem salva e ligada ao step: ${storagePath}` : `Imagem salva (sem step ligado): ${storagePath}`,
  };
}
