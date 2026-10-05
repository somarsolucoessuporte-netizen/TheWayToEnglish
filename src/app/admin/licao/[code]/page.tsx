import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireAdmin } from "@/lib/admin/auth";
import { LESSON_STATUSES, findLessons, listLessonImages, listSteps } from "@/lib/admin/data";
import { releaseField } from "../../actions";
import { DataError } from "../../DataError";
import { ImageUploadForm, LessonEditForm } from "../../forms";

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
  let steps: Awaited<ReturnType<typeof listSteps>>;
  let images: Awaited<ReturnType<typeof listLessonImages>>;
  try {
    [steps, images] = await Promise.all([listSteps(lesson.id), listLessonImages(lesson)]);
  } catch (error) {
    return <DataError error={error} />;
  }

  return (
    <>
      <p className="admin-breadcrumb">
        <Link href="/admin">← Lições</Link> · {lesson.unit.book.title} / {lesson.unit.title ?? lesson.unit.code}
      </p>
      <h1 className="admin-title">
        {lesson.code} — {lesson.title ?? "(sem título)"}
      </h1>

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
            legacy_tasks: lesson.legacy_tasks,
            requires_images: lesson.requires_images,
            image_note: lesson.image_note,
          }}
        />
      </div>

      <div className="admin-card">
        <h3>Imagens</h3>
        <ImageUploadForm
          lessonId={lesson.id}
          steps={steps.map((s) => ({
            id: s.id,
            label: `Step ${s.order} · ${s.mechanic}${s.image_path ? " (já tem imagem)" : ""}`,
          }))}
        />
        {images.length > 0 && (
          <div className="admin-images">
            {images.map((img) => {
              const usedBy = steps.filter((s) => s.image_path === img.path).map((s) => `step ${s.order}`);
              return (
                <figure key={img.path}>
                  {img.url && (
                    // eslint-disable-next-line @next/next/no-img-element -- signed URL, short-lived
                    <img src={img.url} alt={img.name} />
                  )}
                  <figcaption>
                    {img.name}
                    <span className="admin-muted">{usedBy.length ? ` · ${usedBy.join(", ")}` : " · sem step"}</span>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        )}
      </div>

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
