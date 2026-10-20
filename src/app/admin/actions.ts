"use server";

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase";
import { requireAdmin } from "@/lib/admin/auth";
import { LESSON_IMAGES_BUCKET, LESSON_STATUSES, getLessonById, lessonImageFolder, signImagePaths } from "@/lib/admin/data";
import {
  DOCX_LESSON_FIELDS,
  applySchoolAdjustments,
  carryImagePaths,
  planLessonMerge,
  stripImagePaths,
  type DocxLesson,
  type UnitAdjustments,
} from "@/lib/admin/mergeLessons";
import adjustments from "@/app-config/curriculum/ajustes-escola.json";

// Every action starts with requireAdmin(): Server Actions are reachable by a
// direct POST, so src/proxy.ts's redirect alone does not protect them. Every
// input is still validated, and rows are always re-read from the database,
// never trusted from the form.

export interface ActionResult {
  ok: boolean;
  message: string;
  details?: string[];
}

export interface TaskImageResult extends ActionResult {
  /** Signed URL of the uploaded image, for the inline thumbnail. */
  url?: string;
}

const fail = (message: string, details?: string[]): ActionResult => ({ ok: false, message, details });

const execFileAsync = promisify(execFile);
const SOURCE_DOCS_BUCKET = "source-docs";
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
      noTasksNote: z.string().optional(),
      sourceExcerpt: z.string().optional(),
    })
  ),
});

const CONTENT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
  );
  return nested.flat();
}

/** Runs scripts/processar-unit.py on an uploaded .docx and merges the result
 * into the unit — see lib/admin/mergeLessons.ts for what is (not) overwritten.
 * Needs Python + python-docx on the server: works on a local `next dev` /
 * `next start`, not on Vercel's Node runtime. */
export async function importDocx(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await requireAdmin();
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
  try {
    const docxPath = path.join(dir, `${book.code}-${unit.code}.docx`);
    const jsonPath = path.join(dir, "unit.json");
    const imagesDir = path.join(dir, "imgs");
    let parsed: z.infer<typeof DocxUnitSchema>;
    await writeFile(docxPath, Buffer.from(await file.arrayBuffer()));
    const python = process.env.PYTHON_BIN || "python";
    try {
      await execFileAsync(
        python,
        [path.join(process.cwd(), "scripts", "processar-unit.py"), docxPath, "--out", jsonPath, "--images", imagesDir],
        { timeout: 120_000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } }
      );
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.trim().split("\n").slice(-5) ?? [];
      return fail("processar-unit.py falhou (o servidor tem Python com python-docx e Pillow?).", stderr);
    }
    const result = DocxUnitSchema.safeParse(JSON.parse(await readFile(jsonPath, "utf8")));
    if (!result.success) return fail("O JSON gerado não tem o formato esperado.", result.error.issues.map((i) => i.message));
    parsed = result.data;

    if (parsed.book !== book.title || parsed.unit !== (unit.title ?? parsed.unit)) {
      return fail(`O .docx foi lido como ${parsed.book} / ${parsed.unit}, mas a unit é ${book.title} / ${unit.title}.`);
    }
    if (parsed.lessons.length === 0) return fail("Nenhuma lição encontrada no .docx — nada foi alterado.");
    const docxLessons = parsed.lessons as DocxLesson[];
    const adjustmentWarnings = applySchoolAdjustments(
      docxLessons,
      (adjustments as unknown as Record<string, UnitAdjustments>)[`${book.code}/${unit.code}`]
    );

    // Principles: the .docx's own; without them, whatever the unit already
    // has (inherited from Book 1 / Unit 1, or edited here) stays.
    const unitUpdate: Record<string, unknown> = { theme: parsed.unitTheme ?? null };
    if ((parsed.globalPrinciples ?? []).length > 0) unitUpdate.global_principles = parsed.globalPrinciples;
    const { error: unitUpdateError } = await supabase.from("units").update(unitUpdate).eq("id", unit.id);
    if (unitUpdateError) return fail(`Erro ao atualizar a unit: ${unitUpdateError.message}`);

    const { data: existing, error: existingError } = await supabase
      .from("lessons")
      .select("id, code, edited_fields, legacy_tasks")
      .eq("unit_id", unit.id);
    if (existingError) return fail(`Erro ao ler as lições: ${existingError.message}`);

    const plan = planLessonMerge(existing ?? [], docxLessons);

    // Images go up before the lessons that point at them. A lesson whose
    // tasks were edited by hand keeps its item images as they are (they may
    // have been replaced here); images with no item (pendentes/) always go up.
    const protectedLessons = new Set(plan.updates.filter((u) => u.protectedFields.includes("legacy_tasks")).map((u) => u.code));
    const images = (await listFiles(imagesDir)).filter((p) => p.includes("/pendentes/") || !protectedLessons.has(p.split("/")[2]));
    const storage = supabase.storage.from(LESSON_IMAGES_BUCKET);
    for (const image of images) {
      const { error } = await storage.upload(image, await readFile(path.join(imagesDir, image)), {
        contentType: CONTENT_TYPES[image.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream",
        upsert: true,
      });
      if (error) return fail(`Erro ao enviar a imagem ${image}: ${error.message}`);
    }
    // The original goes to the private source-docs bucket (created by
    // scripts/carregar-material.cjs), as uploaded.
    const docName = file.name.normalize("NFD").replace(/[^\w.-]+/g, "_");
    const { error: docError } = await supabase.storage
      .from(SOURCE_DOCS_BUCKET)
      .upload(`${book.code}/${unit.code}/${docName}`, await readFile(docxPath), { contentType: file.type || "application/octet-stream", upsert: true });
    if (docError) return fail(`Erro ao guardar o .docx original: ${docError.message}`);

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
      `${plan.updates.length} lições atualizadas, ${plan.inserts.length} novas (status pendente), ${images.length} imagens enviadas.`,
      ...adjustmentWarnings.map((w) => `ajustes-escola.json: ${w}`),
      ...(plan.inserts.length ? [`Novas: ${plan.inserts.map((l) => l.code).join(", ")}`] : []),
      ...plan.updates
        .filter((u) => u.protectedFields.length > 0)
        .map((u) => `${u.code}: mantidos (editados à mão) — ${u.protectedFields.join(", ")}`),
      ...(plan.missingFromDocx.length
        ? [`No banco mas não no .docx (não mexi): ${plan.missingFromDocx.join(", ")}`]
        : []),
    ];
    return { ok: true, message: `${book.title} / ${unit.title}: importação concluída.`, details };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ lesson edit --

const ItemSchema = z
  .object({
    label: z.string().optional(),
    prompt: z.string(),
    expectedAnswer: z.string().nullable(),
    reply: z.string().optional(),
    imagePath: z.string().optional(),
    extraImagePaths: z.array(z.string()).optional(),
    useImage: z.boolean().optional(),
    schoolCheck: z.string().optional(),
  })
  .passthrough();

// passthrough: the JSON editor saves the tasks as typed — items,
// disabled, schoolCheck... — and zod would otherwise drop those keys.
const TaskSchema = z
  .object({
    order: z.number().int(),
    instruction: z.string(),
    type: z.string(),
    imageDependency: z.enum(["oral", "visual", "image-only"]).optional(),
    items: z.array(ItemSchema).optional(),
    disabled: z.boolean().optional(),
  })
  .passthrough();

const EDITABLE_FIELDS = ["title", "status", "practice_note", "legacy_tasks", "requires_images", "image_note"] as const;

function optionalText(value: FormDataEntryValue | null): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? null : text;
}

/** Saves the edit form. Only fields whose value actually changed are written,
 * and each of them is added to edited_fields so a later .docx import keeps it. */
export async function saveLesson(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await requireAdmin();
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

  // The JSON editor never shows imagePath (only the per-task upload sets
  // it): compare without it, and put the stored paths back on save.
  const next = {
    title: optionalText(formData.get("title")),
    status,
    practice_note: optionalText(formData.get("practice_note")),
    legacy_tasks: stripImagePaths(tasks), // as typed (zod would drop unknown keys)
    requires_images: formData.get("requires_images") === "on",
    image_note: optionalText(formData.get("image_note")),
  };
  const before = { ...current, legacy_tasks: stripImagePaths(current.legacy_tasks ?? []) };

  // Tasks are also saved one by one (saveTask), so this form's JSON can be
  // stale. It carries the tasks as they were when the page loaded: JSON left
  // untouched → tasks are not part of this save; JSON edited while the tasks
  // changed underneath → refuse instead of reverting those edits.
  let base: unknown = undefined;
  try {
    base = JSON.parse(String(formData.get("legacy_tasks_base") ?? "null"));
  } catch {}
  const tasksEdited = base == null || !isDeepStrictEqual(next.legacy_tasks, stripImagePaths(base));
  if (tasksEdited && base != null && !isDeepStrictEqual(stripImagePaths(base), before.legacy_tasks)) {
    return fail("As tasks foram alteradas desde que a página abriu — recarregue antes de salvar o JSON.");
  }

  const changed = EDITABLE_FIELDS.filter(
    (f) => (f !== "legacy_tasks" || tasksEdited) && !isDeepStrictEqual(next[f], before[f] ?? null)
  );
  if (changed.length === 0) return { ok: true, message: "Nada mudou — nada foi gravado." };

  const update: Record<string, unknown> = Object.fromEntries(changed.map((f) => [f, next[f]]));
  if ("legacy_tasks" in update) update.legacy_tasks = carryImagePaths(update.legacy_tasks, current.legacy_tasks);
  update.edited_fields = Array.from(new Set([...(current.edited_fields ?? []), ...changed]));
  const { error } = await createServiceClient().from("lessons").update(update).eq("id", current.id);
  if (error) return fail(`Erro ao salvar: ${error.message}`);

  revalidatePath("/admin");
  revalidatePath(`/admin/licao/${encodeURIComponent(current.code)}`);
  return { ok: true, message: `Salvo: ${changed.join(", ")} (marcados como editados à mão).` };
}

/** Removes a field from edited_fields — the next .docx import overwrites it again. */
export async function releaseField(formData: FormData): Promise<void> {
  await requireAdmin();
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

// ------------------------------------------------------ reference content --

const ReferenceContentSchema = z
  .object({
    vocabulary: z.array(z.string()),
    dialogues: z.array(z.array(z.string())),
    grammarNotes: z.array(z.string()).optional(),
    tables: z.array(z.object({ caption: z.string().optional(), rows: z.array(z.array(z.string())) })).optional(),
    practicePhrases: z.array(z.object({ group: z.string(), phrases: z.array(z.string()) })).optional(),
  })
  .passthrough();

type ReferenceContent = z.infer<typeof ReferenceContentSchema>;

/** Drops what the editor leaves behind when a "+ Adicionar" is never filled:
 * blank list entries and empty dialogues/groups. Tables are kept exactly as
 * edited — empty cells and even empty rows exist in the source (lesson A's
 * SYMBOL column, 4E's image table) and are removed only with ×. */
function tidyReferenceContent(content: ReferenceContent): ReferenceContent {
  const lines = (list: string[]) => list.map((x) => x.trim()).filter(Boolean);
  return {
    ...content,
    vocabulary: lines(content.vocabulary),
    dialogues: content.dialogues.map(lines).filter((d) => d.length > 0),
    ...(content.grammarNotes && { grammarNotes: lines(content.grammarNotes) }),
    ...(content.tables && {
      tables: content.tables.map((t) => ({
        ...t,
        ...(t.caption !== undefined && { caption: t.caption.trim() }),
      })),
    }),
    ...(content.practicePhrases && {
      practicePhrases: content.practicePhrases
        .map((g) => ({ group: g.group.trim(), phrases: lines(g.phrases) }))
        .filter((g) => g.group || g.phrases.length > 0),
    }),
  };
}

/** Saves the "Conteúdo de referência" section — what the tutor reads in its
 * prompt. Marks reference_content as edited by hand (a .docx re-import then
 * leaves it alone). Refuses if it changed since the page loaded. */
export interface ReferenceContentResult extends ActionResult {
  /** What is now stored — the editor's new baseline for the next save. */
  content?: unknown;
}

export async function saveReferenceContent(
  _prev: ReferenceContentResult | null,
  formData: FormData
): Promise<ReferenceContentResult> {
  await requireAdmin();
  const lessonId = uuid.safeParse(formData.get("lessonId"));
  if (!lessonId.success) return fail("Lição inválida.");
  let submitted: unknown;
  let base: unknown;
  try {
    submitted = JSON.parse(String(formData.get("reference_content") ?? ""));
    base = JSON.parse(String(formData.get("reference_content_base") ?? "null"));
  } catch {
    return fail("Conteúdo inválido.");
  }
  const parsed = ReferenceContentSchema.safeParse(submitted);
  if (!parsed.success) return fail("Conteúdo em formato inesperado.", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));

  const lesson = await getLessonById(lessonId.data);
  if (!lesson) return fail("Lição não encontrada.");
  if (base != null && !isDeepStrictEqual(base, lesson.reference_content)) {
    return fail("O conteúdo de referência mudou desde que a página abriu — recarregue antes de salvar.");
  }

  const next = tidyReferenceContent(parsed.data);
  if (isDeepStrictEqual(next, lesson.reference_content)) {
    return { ok: true, message: "Nada mudou — nada foi gravado.", content: lesson.reference_content };
  }

  const { error } = await createServiceClient()
    .from("lessons")
    .update({
      reference_content: next,
      edited_fields: Array.from(new Set([...(lesson.edited_fields ?? []), "reference_content"])),
    })
    .eq("id", lesson.id);
  if (error) return fail(`Erro ao salvar: ${error.message}`);
  return { ok: true, message: "Conteúdo de referência salvo (marcado como editado à mão).", content: next };
}

// ------------------------------------------------------------- task edit --

const IMAGE_DEPENDENCIES = new Set(["visual", "image-only"]);

/** Saves one task's instruction and "Usar imagem" choice inside
 * lessons.legacy_tasks. Checked keeps an existing visual/image-only value
 * (or sets "visual"); unchecked removes imageDependency — the image itself
 * stays in Storage and in imagePath, so re-checking brings it back. Marks
 * legacy_tasks as edited by hand so a .docx re-import keeps it. */
export async function saveTask(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  const lessonId = uuid.safeParse(formData.get("lessonId"));
  const order = z.coerce.number().int().safeParse(formData.get("order"));
  if (!lessonId.success || !order.success) return fail("Task inválida.");
  const instruction = String(formData.get("instruction") ?? "").trim();
  if (!instruction) return fail("A instrução não pode ficar vazia.");
  const useImage = formData.get("useImage") === "on";
  const disabled = formData.get("disabled") === "on";

  const lesson = await getLessonById(lessonId.data);
  if (!lesson) return fail("Lição não encontrada.");
  const tasks = Array.isArray(lesson.legacy_tasks) ? (lesson.legacy_tasks as Record<string, unknown>[]) : [];
  const task = tasks.find((t) => t?.order === order.data);
  if (!task) return fail(`A lição não tem task ${order.data}.`);

  const { imageDependency, disabled: _wasDisabled, ...rest } = task;
  const updatedTask: Record<string, unknown> = { ...rest, instruction };
  if (useImage) {
    updatedTask.imageDependency = IMAGE_DEPENDENCIES.has(String(imageDependency)) ? imageDependency : "visual";
  }
  // Off = the tutor skips the task; disabledReason stays as a record of why.
  if (disabled) updatedTask.disabled = true;
  if (isDeepStrictEqual(updatedTask, task)) return { ok: true, message: "Nada mudou." };

  const { error } = await createServiceClient()
    .from("lessons")
    .update({
      legacy_tasks: tasks.map((t) => (t === task ? updatedTask : t)),
      edited_fields: Array.from(new Set([...(lesson.edited_fields ?? []), "legacy_tasks"])),
    })
    .eq("id", lesson.id);
  if (error) return fail(`Erro ao salvar a task: ${error.message}`);
  return { ok: true, message: `Task ${order.data} salva.` };
}

// ----------------------------------------------------------- image upload --

/** Uploads the image of one task to lesson-images/<book>/<unit>/<lesson>/
 * task-<order>.<ext> (replacing any previous one) and stores that path as the
 * task's imagePath inside lessons.legacy_tasks. Returns a signed URL so the
 * thumbnail updates in place. */
export async function uploadTaskImage(_prev: TaskImageResult | null, formData: FormData): Promise<TaskImageResult> {
  await requireAdmin();
  const lessonId = uuid.safeParse(formData.get("lessonId"));
  const order = z.coerce.number().int().safeParse(formData.get("order"));
  const file = formData.get("file");
  if (!lessonId.success || !order.success) return fail("Task inválida.");
  if (!(file instanceof File) || file.size === 0) return fail("Escolha uma imagem.");
  const extension = IMAGE_TYPES[file.type];
  if (!extension) return fail("Formato não aceito (PNG, JPG, WEBP, GIF ou SVG).");
  if (file.size > MAX_IMAGE_BYTES) return fail("Imagem grande demais (máx. 8 MB).");

  const lesson = await getLessonById(lessonId.data);
  if (!lesson) return fail("Lição não encontrada.");
  const tasks = Array.isArray(lesson.legacy_tasks) ? (lesson.legacy_tasks as Record<string, unknown>[]) : [];
  const task = tasks.find((t) => t?.order === order.data);
  if (!task) return fail(`A lição não tem task ${order.data}.`);

  const supabase = createServiceClient();
  const storage = supabase.storage.from(LESSON_IMAGES_BUCKET);
  const storagePath = `${lessonImageFolder(lesson)}/task-${order.data}.${extension}`;
  const { error: uploadError } = await storage.upload(storagePath, Buffer.from(await file.arrayBuffer()), {
    contentType: file.type,
    upsert: true,
  });
  if (uploadError) return fail(`Erro no upload: ${uploadError.message}`);

  const previous = typeof task.imagePath === "string" ? task.imagePath : undefined;
  const updated = tasks.map((t) => (t === task ? { ...t, imagePath: storagePath } : t));
  const { error } = await supabase.from("lessons").update({ legacy_tasks: updated }).eq("id", lesson.id);
  if (error) return fail(`Imagem enviada, mas a task não foi atualizada: ${error.message}`);
  // Same task, other format (task-1.png → task-1.jpg): drop the orphan.
  if (previous && previous !== storagePath) await storage.remove([previous]);

  const urls = await signImagePaths([storagePath]).catch(() => ({} as Record<string, string>));
  return { ok: true, message: `Imagem da task ${order.data} salva.`, url: urls[storagePath] };
}

// ------------------------------------------------------------ task items --

type TaskRecord = Record<string, unknown> & { order?: unknown; items?: unknown };

/** The lesson and the task `order` from the database (never from the form). */
async function loadTask(lessonId: string, order: number) {
  const lesson = await getLessonById(lessonId);
  if (!lesson) return { error: "Lição não encontrada." } as const;
  const tasks = Array.isArray(lesson.legacy_tasks) ? (lesson.legacy_tasks as TaskRecord[]) : [];
  const task = tasks.find((t) => t?.order === order);
  if (!task) return { error: `A lição não tem task ${order}.` } as const;
  const items = Array.isArray(task.items) ? (task.items as Record<string, unknown>[]) : [];
  return { lesson, tasks, task, items } as const;
}

/** Writes the task's new items and marks legacy_tasks as edited by hand —
 * a .docx re-import then keeps the lesson's tasks (and their images). */
async function writeItems(
  lesson: NonNullable<Awaited<ReturnType<typeof getLessonById>>>,
  tasks: TaskRecord[],
  task: TaskRecord,
  items: Record<string, unknown>[]
): Promise<string | undefined> {
  const { error } = await createServiceClient()
    .from("lessons")
    .update({
      legacy_tasks: tasks.map((t) => (t === task ? { ...t, items } : t)),
      edited_fields: Array.from(new Set([...(lesson.edited_fields ?? []), "legacy_tasks"])),
    })
    .eq("id", lesson.id);
  revalidatePath(`/admin/licao/${encodeURIComponent(lesson.code)}`);
  return error?.message;
}

/** The images that may be linked to an item: files of this lesson's folder. */
function inLessonFolder(lesson: NonNullable<Awaited<ReturnType<typeof getLessonById>>>, imagePath: string): boolean {
  const folder = `${lessonImageFolder(lesson)}/`;
  return imagePath.startsWith(folder) && !imagePath.slice(folder.length).includes("..");
}

export interface ItemsResult extends ActionResult {
  /** The task's items as now stored — the editor's new baseline. */
  items?: unknown[];
}

/** Saves the items editor of one task (cue, expected answer, "Usar
 * imagem", added/removed items). Picture paths can only point into the
 * lesson's own folder. Refuses if the items changed since the editor
 * loaded them. */
export async function saveTaskItems(_prev: ItemsResult | null, formData: FormData): Promise<ItemsResult> {
  await requireAdmin();
  const lessonId = uuid.safeParse(formData.get("lessonId"));
  const order = z.coerce.number().int().safeParse(formData.get("order"));
  if (!lessonId.success || !order.success) return fail("Task inválida.");
  let submitted: unknown;
  let base: unknown;
  try {
    submitted = JSON.parse(String(formData.get("items") ?? ""));
    base = JSON.parse(String(formData.get("items_base") ?? "null"));
  } catch {
    return fail("Itens inválidos.");
  }
  const parsed = z.array(ItemSchema).safeParse(submitted);
  if (!parsed.success) return fail("Itens em formato inesperado.", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));

  const found = await loadTask(lessonId.data, order.data);
  if ("error" in found) return fail(found.error ?? "Task inválida.");
  const { lesson, tasks, task, items: current } = found;
  if (base != null && !isDeepStrictEqual(base, current)) {
    return fail("Os itens mudaram desde que a página abriu — recarregue antes de salvar.");
  }
  const outside = parsed.data
    .flatMap((i) => [i.imagePath, ...(i.extraImagePaths ?? [])])
    .filter((p): p is string => typeof p === "string" && !inLessonFolder(lesson, p));
  if (outside.length > 0) return fail("Imagem fora da pasta desta lição.", outside);

  const items = parsed.data.map((item) => {
    const { label, reply, schoolCheck, ...rest } = item;
    return {
      ...(label?.trim() && { label: label.trim() }),
      ...rest,
      prompt: rest.prompt.trim(),
      expectedAnswer: rest.expectedAnswer?.trim() ? rest.expectedAnswer.trim() : null,
      ...(reply?.trim() && { reply: reply.trim() }),
      ...(schoolCheck?.trim() && { schoolCheck: schoolCheck.trim() }),
    };
  });
  if (isDeepStrictEqual(items, current)) return { ok: true, message: "Nada mudou.", items: current };
  const error = await writeItems(lesson, tasks, task, items);
  if (error) return fail(`Erro ao salvar os itens: ${error}`);
  return { ok: true, message: `Itens da task ${order.data} salvos (tasks marcadas como editadas à mão).`, items };
}

/** Uploads a new picture for one item (lesson-images/<book>/<unit>/<lesson>/
 * task-<n>-item-<m>-<stamp>.<ext> — a new name each time, so a browser or
 * CDN never shows the old one) and links it. The previous file stays in the
 * folder and shows up under "Imagens sem item". */
export async function uploadItemImage(_prev: ItemsResult | null, formData: FormData): Promise<ItemsResult> {
  await requireAdmin();
  const lessonId = uuid.safeParse(formData.get("lessonId"));
  const order = z.coerce.number().int().safeParse(formData.get("order"));
  const index = z.coerce.number().int().min(0).safeParse(formData.get("index"));
  const file = formData.get("file");
  if (!lessonId.success || !order.success || !index.success) return fail("Item inválido.");
  if (!(file instanceof File) || file.size === 0) return fail("Escolha uma imagem.");
  const extension = IMAGE_TYPES[file.type];
  if (!extension) return fail("Formato não aceito (PNG, JPG, WEBP, GIF ou SVG).");
  if (file.size > MAX_IMAGE_BYTES) return fail("Imagem grande demais (máx. 8 MB).");

  const found = await loadTask(lessonId.data, order.data);
  if ("error" in found) return fail(found.error ?? "Task inválida.");
  const { lesson, tasks, task, items } = found;
  if (!items[index.data]) return fail(`A task ${order.data} não tem item ${index.data + 1}.`);

  const storagePath = `${lessonImageFolder(lesson)}/task-${order.data}-item-${index.data + 1}-${Date.now().toString(36)}.${extension}`;
  const { error: uploadError } = await createServiceClient()
    .storage.from(LESSON_IMAGES_BUCKET)
    .upload(storagePath, Buffer.from(await file.arrayBuffer()), { contentType: file.type });
  if (uploadError) return fail(`Erro no upload: ${uploadError.message}`);

  const updated = items.map((item, i) => (i === index.data ? { ...item, imagePath: storagePath } : item));
  const error = await writeItems(lesson, tasks, task, updated);
  if (error) return fail(`Imagem enviada, mas o item não foi atualizado: ${error}`);
  return { ok: true, message: `Imagem do item ${index.data + 1} salva.`, items: updated };
}

/** Links an image already in the lesson folder (an "Imagens sem item" one,
 * or one taken from another item) to an item — or, with no path, unlinks
 * the item's picture. Files are never deleted. */
export async function linkItemImage(_prev: ItemsResult | null, formData: FormData): Promise<ItemsResult> {
  await requireAdmin();
  const lessonId = uuid.safeParse(formData.get("lessonId"));
  const order = z.coerce.number().int().safeParse(formData.get("order"));
  const index = z.coerce.number().int().min(0).safeParse(formData.get("index"));
  const imagePath = String(formData.get("imagePath") ?? "").trim();
  if (!lessonId.success || !order.success || !index.success) return fail("Item inválido.");

  const found = await loadTask(lessonId.data, order.data);
  if ("error" in found) return fail(found.error ?? "Task inválida.");
  const { lesson, tasks, task, items } = found;
  if (!items[index.data]) return fail(`A task ${order.data} não tem item ${index.data + 1}.`);
  if (imagePath && !inLessonFolder(lesson, imagePath)) return fail("Imagem fora da pasta desta lição.");

  const updated = items.map((item, i) => {
    if (i !== index.data) return item;
    const { imagePath: _old, extraImagePaths: _extras, ...rest } = item;
    return imagePath ? { ...rest, imagePath } : rest;
  });
  const error = await writeItems(lesson, tasks, task, updated);
  if (error) return fail(`Erro ao salvar: ${error}`);
  return {
    ok: true,
    message: imagePath ? `Imagem ligada ao item ${index.data + 1} da task ${order.data}.` : `Imagem tirada do item ${index.data + 1}.`,
    items: updated,
  };
}

// ------------------------------------------------------- unit principles --

/** Saves a unit's global principles (one per line). A saved list is the
 * unit's own — no longer "herdado ... aguardando escola". */
export async function saveUnitPrinciples(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await requireAdmin();
  const unitId = uuid.safeParse(formData.get("unitId"));
  if (!unitId.success) return fail("Unit inválida.");
  const principles = String(formData.get("principles") ?? "")
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const { error } = await createServiceClient().from("units").update({ global_principles: principles }).eq("id", unitId.data);
  if (error) return fail(`Erro ao salvar: ${error.message}`);
  revalidatePath("/admin");
  return { ok: true, message: `${principles.length} princípios salvos (agora próprios desta unit).` };
}
