"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { linkItemImage, saveTaskItems, uploadItemImage, type ItemsResult } from "./actions";

// /admin's per-task items editor and the lesson's "Imagens sem item" area.
// Text edits (cue, expected answer, "Usar imagem", added/removed items) are
// saved together with "Salvar itens"; picture changes (replace, remove,
// link — also by dragging an image onto an item) are saved right away, so
// they wait until the text edits are saved.

export interface EditorItem {
  label?: string;
  prompt: string;
  expectedAnswer: string | null;
  reply?: string;
  imagePath?: string;
  extraImagePaths?: string[];
  useImage?: boolean;
  schoolCheck?: string;
  [key: string]: unknown;
}

/** dataTransfer type of a dragged lesson image (its storage path). */
const DRAG_TYPE = "application/x-lesson-image";

function fileName(path: string): string {
  return path.split("/").slice(-2).join("/");
}

function Thumb({ url, alt }: { url?: string; alt: string }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
    <img src={url} alt={alt} />
  ) : (
    <span className="admin-muted">sem imagem</span>
  );
}

/** Runs one of the immediate picture actions and refreshes the page. */
function useImageAction(action: typeof linkItemImage) {
  const router = useRouter();
  const [state, run, pending] = useActionState(action, null);
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return [state, run, pending] as const;
}

export function TaskItemsEditor({
  lessonId,
  order,
  initialItems,
  imageUrls,
}: {
  lessonId: string;
  order: number;
  initialItems: EditorItem[];
  imageUrls: Record<string, string>;
}) {
  const [items, setItems] = useState<EditorItem[]>(initialItems);
  const [base, setBase] = useState<EditorItem[]>(initialItems);
  const [state, save, saving] = useActionState(saveTaskItems, null);
  const [imageState, runImage, imagePending] = useImageAction(linkItemImage);
  const [uploadState, runUpload, uploading] = useImageAction(uploadItemImage);
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  useEffect(() => {
    if (state?.ok && state.items) {
      setItems(state.items as EditorItem[]);
      setBase(state.items as EditorItem[]);
    }
  }, [state]);

  const dirty = JSON.stringify(items) !== JSON.stringify(base);
  const busy = saving || imagePending || uploading;
  const update = (index: number, patch: Partial<EditorItem>) =>
    setItems((list) => list.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  function imageForm(index: number, fields: Record<string, string>): FormData {
    const formData = new FormData();
    formData.set("lessonId", lessonId);
    formData.set("order", String(order));
    formData.set("index", String(index));
    for (const [k, v] of Object.entries(fields)) formData.set(k, v);
    return formData;
  }

  function link(index: number, imagePath: string) {
    if (dirty) return;
    startTransition(() => runImage(imageForm(index, { imagePath })));
  }

  const imageMessage = [uploadState, imageState].find((s) => s && !s.ok) ?? uploadState ?? imageState;

  return (
    <div className="admin-items">
      {items.length === 0 && <p className="admin-hint">Sem itens.</p>}
      <ol className="admin-items-list">
        {items.map((item, index) => {
          const paths = [item.imagePath, ...(item.extraImagePaths ?? [])].filter((p): p is string => !!p);
          return (
            <li key={index} className={`admin-item${item.useImage === false ? " is-image-off" : ""}`}>
              <div className="admin-item-number">{index + 1}</div>
              <div className="admin-item-fields">
                <div className="admin-item-row">
                  <input
                    type="text"
                    className="admin-item-label"
                    value={item.label ?? ""}
                    placeholder="rótulo"
                    aria-label={`Rótulo do item ${index + 1}`}
                    onChange={(e) => update(index, { label: e.currentTarget.value })}
                  />
                  <textarea
                    rows={2}
                    value={item.prompt}
                    placeholder="Dica / pergunta da Debbie"
                    aria-label={`Dica do item ${index + 1}`}
                    onChange={(e) => update(index, { prompt: e.currentTarget.value })}
                  />
                </div>
                <textarea
                  rows={2}
                  value={item.expectedAnswer ?? ""}
                  placeholder="Resposta esperada (vazio = sem resposta fixa)"
                  aria-label={`Resposta esperada do item ${index + 1}`}
                  onChange={(e) => update(index, { expectedAnswer: e.currentTarget.value })}
                />
                {item.reply !== undefined && (
                  <input
                    type="text"
                    value={item.reply}
                    placeholder="A Debbie responde"
                    aria-label={`Resposta da Debbie no item ${index + 1}`}
                    onChange={(e) => update(index, { reply: e.currentTarget.value })}
                  />
                )}
                {item.schoolCheck && (
                  <div className="admin-school-check">
                    <strong>Verificar com a escola:</strong> {item.schoolCheck}
                    <button
                      type="button"
                      className="admin-button is-small is-ghost"
                      onClick={() => update(index, { schoolCheck: undefined })}
                    >
                      Resolvido
                    </button>
                  </div>
                )}
              </div>

              <div
                className={`admin-item-image${dropTarget === index ? " is-drop-target" : ""}`}
                onDragOver={(e) => {
                  if (!dirty && e.dataTransfer.types.includes(DRAG_TYPE)) {
                    e.preventDefault();
                    setDropTarget(index);
                  }
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropTarget(null);
                  const path = e.dataTransfer.getData(DRAG_TYPE);
                  if (path) link(index, path);
                }}
              >
                <div className="admin-thumb">
                  {paths.length === 0 ? <Thumb alt="" /> : paths.map((p) => <Thumb key={p} url={imageUrls[p]} alt={fileName(p)} />)}
                </div>
                <div className="admin-item-image-actions">
                  <label className={`admin-button is-small is-ghost admin-file-button${dirty || busy ? " is-disabled" : ""}`}>
                    {item.imagePath ? "Trocar" : "Enviar"}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                      disabled={dirty || busy}
                      onChange={(e) => {
                        const file = e.currentTarget.files?.[0];
                        e.currentTarget.value = "";
                        if (!file) return;
                        const formData = imageForm(index, {});
                        formData.set("file", file);
                        startTransition(() => runUpload(formData));
                      }}
                    />
                  </label>
                  {item.imagePath && (
                    <button type="button" className="admin-button is-small is-ghost" disabled={dirty || busy} onClick={() => link(index, "")}>
                      Tirar
                    </button>
                  )}
                </div>
                {paths.length > 0 && (
                  <label className="admin-checkbox-inline">
                    <input
                      type="checkbox"
                      checked={item.useImage !== false}
                      onChange={(e) => update(index, { useImage: e.currentTarget.checked ? undefined : false })}
                    />
                    Usar imagem
                  </label>
                )}
              </div>

              <button
                type="button"
                className="admin-remove"
                aria-label={`Remover item ${index + 1}`}
                title={`Remover item ${index + 1}`}
                onClick={() => setItems((list) => list.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </li>
          );
        })}
      </ol>

      <div className="admin-task-actions">
        <button
          type="button"
          className="admin-button is-small is-ghost"
          onClick={() => setItems((list) => [...list, { prompt: "", expectedAnswer: null }])}
        >
          + Adicionar item
        </button>
        <button
          type="button"
          className="admin-button is-small"
          disabled={!dirty || busy}
          onClick={() => {
            const formData = new FormData();
            formData.set("lessonId", lessonId);
            formData.set("order", String(order));
            formData.set("items", JSON.stringify(items));
            formData.set("items_base", JSON.stringify(base));
            startTransition(() => save(formData));
          }}
        >
          {saving ? "Salvando…" : "Salvar itens"}
        </button>
        {dirty && <span className="admin-muted">Salve os itens antes de mexer nas imagens.</span>}
        {state && <span className={state.ok ? "admin-inline-ok" : "admin-inline-error"}>{state.message}</span>}
        {imageMessage && !state && (
          <span className={imageMessage.ok ? "admin-inline-ok" : "admin-inline-error"}>{imageMessage.message}</span>
        )}
      </div>
    </div>
  );
}

export interface LinkTarget {
  order: number;
  index: number;
  label: string;
}

/** Images in the lesson folder that no item uses: the .docx's floating
 * pictures (pendentes/, with the task the analysis suggests) and pictures
 * taken off an item. Drag one onto an item's picture, or pick the item. */
export function UnlinkedImages({
  lessonId,
  images,
  targets,
}: {
  lessonId: string;
  images: { path: string; url?: string; suggestedTask?: number }[];
  targets: LinkTarget[];
}) {
  const [state, run, pending] = useImageAction(linkItemImage);
  if (images.length === 0) return <p className="admin-hint">Todas as imagens desta lição estão ligadas a um item.</p>;
  return (
    <>
      <p className="admin-hint">
        Imagens do .docx sem frase clara (não foram ligadas por palpite) e imagens tiradas de algum item. Arraste a
        imagem até a foto de um item, ou escolha o item e clique em Ligar.
      </p>
      <ul className="admin-unlinked">
        {images.map((image) => (
          <li key={image.path} className="admin-unlinked-card">
            <div
              className="admin-thumb is-draggable"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, image.path);
                e.dataTransfer.effectAllowed = "link";
              }}
            >
              <Thumb url={image.url} alt={fileName(image.path)} />
            </div>
            <span className="admin-muted admin-file-name">{fileName(image.path)}</span>
            {image.suggestedTask && <span className="admin-tag">sugestão: task {image.suggestedTask}</span>}
            <form
              className="admin-unlinked-form"
              onSubmit={(e) => {
                e.preventDefault();
                const [order, index] = String(new FormData(e.currentTarget).get("target") ?? "").split(":");
                if (!order) return;
                const formData = new FormData();
                formData.set("lessonId", lessonId);
                formData.set("order", order);
                formData.set("index", index);
                formData.set("imagePath", image.path);
                startTransition(() => run(formData));
              }}
            >
              <select
                name="target"
                aria-label="Item para ligar"
                defaultValue={(() => {
                  const first = targets.find((t) => t.order === image.suggestedTask);
                  return first ? `${first.order}:${first.index}` : "";
                })()}
              >
                <option value="">Escolher item…</option>
                {targets.map((t) => (
                  <option key={`${t.order}:${t.index}`} value={`${t.order}:${t.index}`}>
                    {t.label}
                  </option>
                ))}
              </select>
              <button type="submit" className="admin-button is-small" disabled={pending}>
                Ligar
              </button>
            </form>
          </li>
        ))}
      </ul>
      {state && <p className={state.ok ? "admin-inline-ok" : "admin-inline-error"}>{state.message}</p>}
    </>
  );
}
