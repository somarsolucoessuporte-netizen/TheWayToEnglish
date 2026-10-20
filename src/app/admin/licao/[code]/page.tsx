import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireAdmin } from "@/lib/admin/auth";
import { LESSON_STATUSES, findLessons, listLessonFolderImages, listSteps, signImagePaths } from "@/lib/admin/data";
import { TaskItemsEditor, UnlinkedImages, type EditorItem } from "../../ItemsEditor";
import { stripImagePaths } from "@/lib/admin/mergeLessons";
import { releaseField } from "../../actions";
import { DataError } from "../../DataError";
import { LessonEditForm, TaskEditor } from "../../forms";
import { ReferenceContentEditor } from "../../ReferenceContentEditor";

interface TaskRow {
  order: number;
  type?: string;
  instruction?: string;
  imageDependency?: string;
  imagePath?: string;
  items?: EditorItem[];
  disabled?: boolean;
  disabledReason?: string;
  schoolCheck?: string;
}

/** "…/pendentes/imagem-3-sugestao-task-2.png" → 2 (see processar-unit.py's export_images). */
function suggestedTask(path: string): number | undefined {
  const match = path.match(/-sugestao-task-(\d+)\.\w+$/);
  return match ? Number(match[1]) : undefined;
}

function itemPaths(item: EditorItem): string[] {
  return [item.imagePath, ...(item.extraImagePaths ?? [])].filter((p): p is string => typeof p === "string");
}


export default async function AdminLessonPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ unit?: string | string[] }>;
}) {
  await connection();
  await requireAdmin();
  const { code } = await params;
  const { unit } = await searchParams;
  const lessonCode = decodeURIComponent(code);
  const unitId = typeof unit === "string" && /^[0-9a-f-]{36}$/i.test(unit) ? unit : undefined;

  let matches: Awaited<ReturnType<typeof findLessons>>;
  try {
    matches = await findLessons(lessonCode, unitId);
  } catch (error) {
    return <DataError error={error} />;
  }
  if (matches.length === 0) notFound();

  // Codes repeat across units — without ?unit= the choice is the user's.
  if (matches.length > 1) {
    return (
      <>
        <h1 className="admin-title">Lição {lessonCode}</h1>
        <p className="admin-hint">Esse código existe em mais de uma unit. Escolha qual:</p>
        <ul className="admin-list">
          {matches.map((m) => (
            <li key={m.id}>
              <Link href={`/admin/licao/${encodeURIComponent(m.code)}?unit=${m.unit.id}`}>
                {m.unit.book.title} / {m.unit.title ?? m.unit.code} — {m.title ?? m.code}
              </Link>
            </li>
          ))}
        </ul>
      </>
    );
  }

  const lesson = matches[0];
  const tasks = (Array.isArray(lesson.legacy_tasks) ? (lesson.legacy_tasks as TaskRow[]) : [])
    .filter((t) => t && typeof t.order === "number")
    .sort((a, b) => a.order - b.order);
  const usedPaths = new Set(
    tasks.flatMap((t) => [t.imagePath, ...(t.items ?? []).flatMap(itemPaths)]).filter((p): p is string => typeof p === "string")
  );
  let steps: Awaited<ReturnType<typeof listSteps>>;
  let imageUrls: Record<string, string>;
  let folderImages: string[];
  try {
    [steps, folderImages] = await Promise.all([listSteps(lesson.id), listLessonFolderImages(lesson)]);
    imageUrls = await signImagePaths(Array.from(new Set([...usedPaths, ...folderImages])));
  } catch (error) {
    return <DataError error={error} />;
  }
  const unlinked = folderImages
    .filter((p) => !usedPaths.has(p))
    .map((path) => ({ path, url: imageUrls[path], suggestedTask: suggestedTask(path) }));
  const linkTargets = tasks.flatMap((t) =>
    (t.items ?? []).map((item, index) => ({
      order: t.order,
      index,
      label: `Task ${t.order} · item ${index + 1}${item.imagePath ? " (troca a imagem)" : ""} — ${(item.prompt || item.expectedAnswer || "").slice(0, 60)}`,
    }))
  );
  const reference = (lesson.reference_content ?? {}) as { schoolChecks?: string[] };

  return (
    <>
      <p className="admin-breadcrumb">
        <Link href="/admin">← Lições</Link> · {lesson.unit.book.title} / {lesson.unit.title ?? lesson.unit.code}
      </p>
      <h1 className="admin-title">
        {lesson.code} — {lesson.title ?? "(sem título)"}
      </h1>

      {(reference.schoolChecks ?? []).length > 0 && (
        <div className="admin-card admin-school-check">
          <h3>Verificar com a escola</h3>
          <ul>
            {reference.schoolChecks!.map((check) => (
              <li key={check}>{check}</li>
            ))}
          </ul>
          <p className="admin-hint">Gravado como a escola escreveu — nada foi corrigido por conta própria.</p>
        </div>
      )}

      {lesson.edited_fields.length > 0 && (
        <div className="admin-card">
          <h3>Campos protegidos (editados à mão)</h3>
          <p className="admin-hint">Um novo upload do .docx não sobrescreve estes campos. Liberar = o próximo .docx volta a valer.</p>
          <ul className="admin-protected">
            {lesson.edited_fields.map((field) => (
              <li key={field}>
                <code>{field}</code>
                <form action={releaseField}>
                  <input type="hidden" name="lessonId" value={lesson.id} />
                  <input type="hidden" name="field" value={field} />
                  <button type="submit" className="admin-button is-small is-ghost">
                    Liberar
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="admin-card">
        <h3>Editar lição</h3>
        <LessonEditForm
          statuses={LESSON_STATUSES}
          lesson={{
            id: lesson.id,
            title: lesson.title,
            status: lesson.status,
            practice_note: lesson.practice_note,
            legacy_tasks: stripImagePaths(lesson.legacy_tasks ?? []),
            requires_images: lesson.requires_images,
            image_note: lesson.image_note,
          }}
        />
      </div>

      <div className="admin-card">
        <h3>Tasks</h3>
        {tasks.length === 0 ? (
          <p className="admin-hint">Esta lição não tem tasks.</p>
        ) : (
          <ol className="admin-tasks">
            {tasks.map((task) => (
              <li key={task.order} className="admin-task">
                <div className="admin-task-order">{task.order}</div>
                <div className="admin-task-body">
                  <TaskEditor
                    lessonId={lesson.id}
                    task={{
                      order: task.order,
                      type: task.type,
                      instruction: task.instruction,
                      imageDependency: task.imageDependency,
                      disabled: task.disabled,
                      disabledReason: task.disabledReason,
                      schoolCheck: task.schoolCheck,
                      hasItems: (task.items ?? []).length > 0,
                    }}
                    initialUrl={task.imagePath ? imageUrls[task.imagePath] : undefined}
                  />
                  <details className="admin-details" open={(task.items ?? []).length > 0 && (task.items ?? []).length <= 12}>
                    <summary>Itens ({(task.items ?? []).length})</summary>
                    <TaskItemsEditor
                      key={JSON.stringify(task.items ?? [])}
                      lessonId={lesson.id}
                      order={task.order}
                      initialItems={task.items ?? []}
                      imageUrls={imageUrls}
                    />
                  </details>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="admin-card">
        <h3>Imagens sem item ({unlinked.length})</h3>
        <UnlinkedImages lessonId={lesson.id} images={unlinked} targets={linkTargets} />
      </div>

      <div className="admin-card">
        <h3>Conteúdo de referência</h3>
        <p className="admin-hint">
          O material que a Debbie lê no prompt desta lição. Salvar marca o conteúdo como editado à mão — o próximo
          .docx não o sobrescreve.
        </p>
        <ReferenceContentEditor lessonId={lesson.id} initial={lesson.reference_content} />
      </div>

      {lesson.source_excerpt && (
        <div className="admin-card">
          <details className="admin-details">
            <summary>Texto original do .docx</summary>
            <pre className="admin-source">{lesson.source_excerpt}</pre>
          </details>
        </div>
      )}

      <div className="admin-card">
        <h3>Steps</h3>
        {steps.length === 0 ? (
          <p className="admin-hint">Nenhum step ainda — a lição roda pelas legacy_tasks.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Mecânica</th>
                  <th>Prompt</th>
                  <th>Imagem</th>
                  <th>Editado à mão</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((s) => (
                  <tr key={s.id}>
                    <td>{s.order}</td>
                    <td>{s.mechanic}</td>
                    <td>{s.prompt_text ?? <span className="admin-muted">—</span>}</td>
                    <td>{s.image_path ?? <span className="admin-muted">—</span>}</td>
                    <td>{s.edited_manually ? "sim" : "não"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
