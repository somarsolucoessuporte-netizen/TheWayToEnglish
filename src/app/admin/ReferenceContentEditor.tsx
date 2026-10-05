"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { saveReferenceContent } from "./actions";

// "Conteúdo de referência": the lesson material the tutor reads in its prompt
// (vocabulary, tables, practice phrases, dialogues, notes), edited as lists —
// never as raw JSON. Shape matches CurriculumReferenceContent.

interface Table {
  caption?: string;
  rows: string[][];
}

interface PhraseGroup {
  group: string;
  phrases: string[];
}

export interface ReferenceContent {
  vocabulary: string[];
  dialogues: string[][];
  grammarNotes?: string[];
  tables?: Table[];
  practicePhrases?: PhraseGroup[];
  [key: string]: unknown;
}

function normalize(value: unknown): ReferenceContent {
  const v = (value && typeof value === "object" ? value : {}) as Partial<ReferenceContent>;
  return { ...v, vocabulary: v.vocabulary ?? [], dialogues: v.dialogues ?? [] };
}

const replaceAt = <T,>(list: T[], index: number, value: T) => list.map((x, i) => (i === index ? value : x));
const removeAt = <T,>(list: T[], index: number) => list.filter((_, i) => i !== index);

function RemoveButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="admin-remove" onClick={onClick} aria-label={label} title={label}>
      ×
    </button>
  );
}

function AddButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className="admin-button is-small is-ghost" onClick={onClick}>
      + {children}
    </button>
  );
}

function StringList({
  items,
  onChange,
  addLabel,
  itemLabel,
  multiline = false,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  addLabel: string;
  itemLabel: string;
  multiline?: boolean;
}) {
  return (
    <div className="admin-list-editor">
      {items.map((item, i) => (
        <div key={i} className="admin-list-row">
          {multiline ? (
            <textarea rows={2} value={item} aria-label={`${itemLabel} ${i + 1}`} onChange={(e) => onChange(replaceAt(items, i, e.target.value))} />
          ) : (
            <input type="text" value={item} aria-label={`${itemLabel} ${i + 1}`} onChange={(e) => onChange(replaceAt(items, i, e.target.value))} />
          )}
          <RemoveButton label={`Remover ${itemLabel.toLowerCase()} ${i + 1}`} onClick={() => onChange(removeAt(items, i))} />
        </div>
      ))}
      <AddButton onClick={() => onChange([...items, ""])}>{addLabel}</AddButton>
    </div>
  );
}

function TableEditor({ table, onChange, onRemove, index }: { table: Table; onChange: (t: Table) => void; onRemove: () => void; index: number }) {
  const width = Math.max(1, ...table.rows.map((r) => r.length));
  const setCell = (r: number, c: number, value: string) =>
    onChange({ ...table, rows: replaceAt(table.rows, r, replaceAt(padRow(table.rows[r], width), c, value)) });
  return (
    <div className="admin-ref-block">
      <div className="admin-list-row">
        <input
          type="text"
          className="admin-ref-caption"
          placeholder="Título da tabela"
          aria-label={`Título da tabela ${index + 1}`}
          value={table.caption ?? ""}
          onChange={(e) => onChange({ ...table, caption: e.target.value })}
        />
        <RemoveButton label={`Remover tabela ${index + 1}`} onClick={onRemove} />
      </div>
      <div className="admin-table-wrap">
        <table className="admin-ref-table">
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={r} className={r === 0 ? "is-header" : undefined}>
                {padRow(row, width).map((cell, c) => (
                  <td key={c}>
                    <input type="text" value={cell} aria-label={`Tabela ${index + 1}, linha ${r + 1}, coluna ${c + 1}`} onChange={(e) => setCell(r, c, e.target.value)} />
                  </td>
                ))}
                <td className="admin-ref-table-action">
                  <RemoveButton label={`Remover linha ${r + 1}`} onClick={() => onChange({ ...table, rows: removeAt(table.rows, r) })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AddButton onClick={() => onChange({ ...table, rows: [...table.rows, Array(width).fill("")] })}>Adicionar linha</AddButton>
    </div>
  );
}

function padRow(row: string[] | undefined, width: number): string[] {
  const cells = row ?? [];
  return cells.length >= width ? cells : [...cells, ...Array(width - cells.length).fill("")];
}

export function ReferenceContentEditor({ lessonId, initial }: { lessonId: string; initial: unknown }) {
  const [content, setContent] = useState(() => normalize(initial));
  const [base, setBase] = useState<unknown>(initial);
  const [state, action, pending] = useActionState(saveReferenceContent, null);

  // After a save, the stored (tidied) version becomes both what is shown and
  // the baseline the next save is checked against.
  useEffect(() => {
    if (state?.ok && state.content !== undefined) {
      setBase(state.content);
      setContent(normalize(state.content));
    }
  }, [state]);

  const set = <K extends keyof ReferenceContent>(key: K, value: ReferenceContent[K]) => setContent((c) => ({ ...c, [key]: value }));
  const tables = content.tables ?? [];
  const groups = content.practicePhrases ?? [];

  return (
    <form
      className="admin-ref"
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData();
        formData.set("lessonId", lessonId);
        formData.set("reference_content", JSON.stringify(content));
        formData.set("reference_content_base", JSON.stringify(base ?? null));
        startTransition(() => action(formData));
      }}
    >
      <section>
        <h4>Vocabulário</h4>
        <StringList items={content.vocabulary} onChange={(v) => set("vocabulary", v)} addLabel="Adicionar item" itemLabel="Item" />
      </section>

      <section>
        <h4>Tabelas</h4>
        {tables.map((table, i) => (
          <TableEditor
            key={i}
            index={i}
            table={table}
            onChange={(t) => set("tables", replaceAt(tables, i, t))}
            onRemove={() => set("tables", removeAt(tables, i))}
          />
        ))}
        <AddButton onClick={() => set("tables", [...tables, { caption: "", rows: [["", ""]] }])}>Adicionar tabela</AddButton>
      </section>

      <section>
        <h4>Frases de prática</h4>
        {groups.map((group, i) => (
          <div key={i} className="admin-ref-block">
            <div className="admin-list-row">
              <input
                type="text"
                className="admin-ref-caption"
                placeholder="Nome do grupo"
                aria-label={`Grupo ${i + 1}`}
                value={group.group}
                onChange={(e) => set("practicePhrases", replaceAt(groups, i, { ...group, group: e.target.value }))}
              />
              <RemoveButton label={`Remover grupo ${i + 1}`} onClick={() => set("practicePhrases", removeAt(groups, i))} />
            </div>
            <StringList
              items={group.phrases}
              onChange={(phrases) => set("practicePhrases", replaceAt(groups, i, { ...group, phrases }))}
              addLabel="Adicionar frase"
              itemLabel="Frase"
            />
          </div>
        ))}
        <AddButton onClick={() => set("practicePhrases", [...groups, { group: "", phrases: [""] }])}>Adicionar grupo</AddButton>
      </section>

      <section>
        <h4>Diálogos</h4>
        {content.dialogues.map((dialogue, i) => (
          <div key={i} className="admin-ref-block">
            <div className="admin-ref-block-header">
              <span className="admin-muted">Diálogo {i + 1}</span>
              <RemoveButton label={`Remover diálogo ${i + 1}`} onClick={() => set("dialogues", removeAt(content.dialogues, i))} />
            </div>
            <StringList
              items={dialogue}
              onChange={(lines) => set("dialogues", replaceAt(content.dialogues, i, lines))}
              addLabel="Adicionar linha"
              itemLabel="Linha"
            />
          </div>
        ))}
        <AddButton onClick={() => set("dialogues", [...content.dialogues, ["A: ", "B: "]])}>Adicionar diálogo</AddButton>
      </section>

      <section>
        <h4>Notas</h4>
        <StringList
          items={content.grammarNotes ?? []}
          onChange={(notes) => set("grammarNotes", notes)}
          addLabel="Adicionar nota"
          itemLabel="Nota"
          multiline
        />
      </section>

      <div className="admin-actions admin-ref-save">
        <button type="submit" className="admin-button" disabled={pending}>
          {pending ? "Salvando…" : "Salvar conteúdo de referência"}
        </button>
        {state && <span className={state.ok ? "admin-inline-ok" : "admin-inline-error"}>{state.message}</span>}
      </div>
      {state && !state.ok && state.details && (
        <ul className="admin-inline-error">
          {state.details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
    </form>
  );
}
