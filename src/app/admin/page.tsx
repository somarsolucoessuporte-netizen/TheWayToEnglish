import Link from "next/link";
import { connection } from "next/server";
import { requireAdmin } from "@/lib/admin/auth";
import { listCurriculum } from "@/lib/admin/data";
import { DataError } from "./DataError";
import { DocxUploadForm } from "./forms";

export default async function AdminHome() {
  await connection();
  await requireAdmin();
  let books: Awaited<ReturnType<typeof listCurriculum>>;
  try {
    books = await listCurriculum();
  } catch (error) {
    return <DataError error={error} />;
  }

  return (
    <>
      <h1 className="admin-title">Lições</h1>
      {books.length === 0 && <p className="admin-hint">Nenhum book no banco.</p>}

      {books.map((book) => (
        <section key={book.id} className="admin-book">
          <h2>{book.title}</h2>

          {book.units.map((unit) => (
            <div key={unit.id} className="admin-card">
              <div className="admin-card-header">
                <h3>{unit.title ?? unit.code}</h3>
                <span className="admin-muted">{unit.lessons.length} lições</span>
              </div>

              <DocxUploadForm unitId={unit.id} unitLabel={`${book.title} / ${unit.title ?? unit.code}`} />

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Código</th>
                      <th>Título</th>
                      <th>Status</th>
                      <th>Imagens</th>
                      <th aria-label="Ações" />
                    </tr>
                  </thead>
                  <tbody>
                    {unit.lessons.map((lesson) => (
                      <tr key={lesson.id}>
                        <td className="admin-code-cell">{lesson.code}</td>
                        <td>
                          {lesson.title ?? <span className="admin-muted">(sem título)</span>}
                          {lesson.edited_fields.length > 0 && (
                            <span className="admin-tag" title={lesson.edited_fields.join(", ")}>
                              editada à mão
                            </span>
                          )}
                        </td>
                        <td>
                          <span className={`admin-status is-${lesson.status}`}>{lesson.status}</span>
                        </td>
                        <td>{lesson.requires_images ? "sim" : "não"}</td>
                        <td>
                          <Link
                            className="admin-button is-small"
                            href={`/admin/licao/${encodeURIComponent(lesson.code)}?unit=${unit.id}`}
                          >
                            Editar
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}
