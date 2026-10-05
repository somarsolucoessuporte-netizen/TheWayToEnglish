"use client";

import { startTransition, useActionState } from "react";
import { importDocx, saveLesson, uploadLessonImage, type ActionResult } from "./actions";

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

      <label>
        <span>legacy_tasks (JSON)</span>
        <textarea
          name="legacy_tasks"
          rows={16}
          spellCheck={false}
          className="admin-code"
          defaultValue={JSON.stringify(lesson.legacy_tasks ?? [], null, 2)}
        />
      </label>

      <label className="admin-checkbox">
        <input type="checkbox" name="requires_images" defaultChecked={lesson.requires_images} />
        <span>requires_images</span>
      </label>

      <label>
        <span>Image note</span>
        <textarea name="image_note" rows={2} defaultValue={lesson.image_note ?? ""} />
      </label>

      <div className="admin-actions">
        <button type="submit" className="admin-button" disabled={pending}>
          {pending ? "Salvando…" : "Salvar"}
        </button>
      </div>
      <Result state={state} />
    </form>
  );
}

export function ImageUploadForm({
  lessonId,
  steps,
}: {
  lessonId: string;
  steps: { id: string; label: string }[];
}) {
  const [state, action, pending] = useActionState(uploadLessonImage, null);
  return (
    <form action={action} className="admin-form">
      <input type="hidden" name="lessonId" value={lessonId} />
      <label>
        <span>Imagem</span>
        <input type="file" name="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" required />
      </label>
      <label>
        <span>Ligar ao step</span>
        <select name="stepId" defaultValue="">
          <option value="">— nenhum (só guardar no Storage) —</option>
          {steps.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {steps.length === 0 && (
        <p className="admin-hint">Esta lição ainda não tem steps — a imagem fica guardada na pasta da lição e pode ser ligada depois.</p>
      )}
      <div className="admin-actions">
        <button type="submit" className="admin-button" disabled={pending}>
          {pending ? "Enviando…" : "Enviar imagem"}
        </button>
      </div>
      <Result state={state} />
    </form>
  );
}
