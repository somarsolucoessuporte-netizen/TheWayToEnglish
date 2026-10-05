"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { importDocx, saveLesson, uploadTaskImage, type ActionResult } from "./actions";

function Result({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return (
    <div className={`admin-result ${state.ok ? "is-ok" : "is-error"}`} role="status">
      <strong>{state.message}</strong>
      {state.details && state.details.length > 0 && (
        <ul>
          {state.details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DocxUploadForm({ unitId, unitLabel }: { unitId: string; unitLabel: string }) {
  const [state, action, pending] = useActionState(importDocx, null);
  return (
    <form action={action} className="admin-inline-form">
      <input type="hidden" name="unitId" value={unitId} />
      <label className="admin-file">
        <span>Upload .docx ({unitLabel})</span>
        <input type="file" name="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" required />
      </label>
      <button type="submit" className="admin-button" disabled={pending}>
        {pending ? "Processando…" : "Enviar e atualizar"}
      </button>
      <Result state={state} />
    </form>
  );
}

export interface LessonFormValues {
  id: string;
  title: string | null;
  status: string;
  practice_note: string | null;
  legacy_tasks: unknown;
  requires_images: boolean;
  image_note: string | null;
}

export function LessonEditForm({ lesson, statuses }: { lesson: LessonFormValues; statuses: string[] }) {
  const [state, action, pending] = useActionState(saveLesson, null);
  // Submitted by hand instead of <form action>: React resets a form after an
  // action runs, which would wipe a half-fixed legacy_tasks JSON on a
  // validation error.
  return (
    <form
      className="admin-form"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        startTransition(() => action(formData));
      }}
    >
      <input type="hidden" name="lessonId" value={lesson.id} />

      <label>
        <span>Título</span>
        <input type="text" name="title" defaultValue={lesson.title ?? ""} />
      </label>

      <label>
        <span>Status</span>
        <select name="status" defaultValue={lesson.status}>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span>Practice note</span>
        <textarea name="practice_note" rows={3} defaultValue={lesson.practice_note ?? ""} />
      </label>

      <label className="admin-checkbox">
        <input type="checkbox" name="requires_images" defaultChecked={lesson.requires_images} />
        <span>requires_images</span>
      </label>

      <label>
        <span>Image note</span>
        <textarea name="image_note" rows={2} defaultValue={lesson.image_note ?? ""} />
      </label>

      {/* Advanced: the tasks themselves (listed read-only in "Tasks" below).
          imagePath is left out on purpose — images are set per task. */}
      <details className="admin-details">
        <summary>Editar tasks como JSON (avançado)</summary>
        <textarea
          name="legacy_tasks"
          rows={16}
          spellCheck={false}
          className="admin-code"
          defaultValue={JSON.stringify(lesson.legacy_tasks ?? [], null, 2)}
        />
      </details>

      <div className="admin-actions">
        <button type="submit" className="admin-button" disabled={pending}>
          {pending ? "Salvando…" : "Salvar"}
        </button>
      </div>
      <Result state={state} />
    </form>
  );
}

/** Inline image for one task: thumbnail + choose + send. The thumbnail
 * switches to the uploaded image as soon as the action returns. */
export function TaskImageUpload({
  lessonId,
  order,
  initialUrl,
}: {
  lessonId: string;
  order: number;
  initialUrl?: string;
}) {
  const [state, action, pending] = useActionState(uploadTaskImage, null);
  const [fileName, setFileName] = useState("");
  // React resets the form (file input included) once the action finishes.
  useEffect(() => setFileName(""), [state]);
  const url = state?.url ?? initialUrl;
  return (
    <div className="admin-task-image">
      <div className="admin-thumb">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
          <img src={url} alt={`Imagem da task ${order}`} />
        ) : (
          <span className="admin-muted">sem imagem</span>
        )}
      </div>
      <form action={action} className="admin-task-image-form">
        <input type="hidden" name="lessonId" value={lessonId} />
        <input type="hidden" name="order" value={order} />
        <label className="admin-button is-small is-ghost admin-file-button">
          Escolher imagem
          <input
            type="file"
            name="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            required
            onChange={(e) => setFileName(e.currentTarget.files?.[0]?.name ?? "")}
          />
        </label>
        {fileName && <span className="admin-muted admin-file-name">{fileName}</span>}
        <button type="submit" className="admin-button is-small" disabled={pending}>
          {pending ? "Enviando…" : "Enviar"}
        </button>
        {state && !state.ok && <span className="admin-inline-error">{state.message}</span>}
        {state?.ok && <span className="admin-inline-ok">{state.message}</span>}
      </form>
    </div>
  );
}
