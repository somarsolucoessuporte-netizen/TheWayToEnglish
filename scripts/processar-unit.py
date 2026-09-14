#!/usr/bin/env python
"""
Extrai um book/unit do formato .docx da escola (instrucoes em vermelho
#EE0000, conteudo de referencia em preto) para o JSON de curriculum
consumido pela Tutora.

Uso:
    python scripts/processar-unit.py material_do_curso/originais/book01/book01-unit01.docx
    python scripts/processar-unit.py <docx> --out <destino.json>
"""
import argparse
import datetime
import json
import re
import sys
from pathlib import Path

import docx
from docx.table import Table
from docx.text.paragraph import Paragraph

# --- deteccao de cor ---------------------------------------------------

def _is_red_rgb(rgb):
    if rgb is None:
        return False
    return rgb[0] > 120 and rgb[1] < 90 and rgb[2] < 90


def classify_paragraph(p):
    """Retorna True se a MAIORIA dos runs com texto forem vermelhos."""
    total = 0
    red = 0
    for r in p.runs:
        if not r.text.strip():
            continue
        total += 1
        rgb = r.font.color.rgb if (r.font.color and r.font.color.type is not None) else None
        if _is_red_rgb(rgb):
            red += 1
    if total == 0:
        return False
    return red > (total - red)


# --- deteccao de titulos de licao --------------------------------------

# Um titulo real e uma linha inteira no formato:
#   [<prefixo curto terminado em travessao>] Lesson(s) <codigo> [ - <subtitulo>]
# Ex.: "Boas-vindas - Lesson A", "Unit 1 - Lesson 3B - Countries and Continents",
#      "Summary - Book 1 - Unit 1 - Lesson 3E", "Book 1 - Unit 1 - Lesson 5 - Review"
TITLE_RE = re.compile(
    r'^(?:.{0,40}?[–—-]\s*)?'
    r'Lessons?\s+(?P<code>[0-9]+[A-Za-z]{0,3}|[A-Za-z])'
    r'(?:\s*[–—-]\s*(?P<subtitle>.+))?$',
    re.IGNORECASE | re.DOTALL,
)

SKILL_WHITELIST = [
    "Speaking", "Vocabulary", "Grammar", "Pronunciation",
    "Listening", "Reading", "Writing", "Review",
]

TASK_TYPE_RULES = [
    # (tipo, padroes regex verificados em ordem de prioridade)
    ("student_leads", [r"aluno.{0,20}iniciar?\s+o\s+di[aá]logo", r"aluno\s+come[çc]arem\s+o\s+di[áa]logo"]),
    ("student_answers", [r"\bpergunta\b"]),
    ("demonstrate", [r"\bmostra\b", r"\bapresenta\b", r"\bl[êe]\b", r"\bpronuncia\b", r"\binicia\s+o\s+di[áa]logo\b"]),
    ("student_repeats", [r"\brepetir\b", r"\brepita\b", r"pede.{0,15}\bler\b"]),
    ("correct", [r"corrigindo", r"\bcorrigir\b"]),
    ("offer_repeat", [r"op[çc][ãa]o.{0,20}repetir", r"quiser\s+repetir", r"quiser\s+fazer\s+mais"]),
    ("explain", [r"\bexplica\b", r"come[çc]a\s+falando", r"mostra\s+que\s+se\s+usa"]),
]

IMAGE_RE = re.compile(r"imagens?", re.IGNORECASE)

# A escola tambem colore de vermelho listas de frases de pratica (nao
# instrucoes) — ex.: a lista de exemplos da licao 3H. So tratamos um
# paragrafo vermelho como INSTRUCAO quando ele fala sobre a IA agindo,
# usa um dos verbos-comando no infinitivo, ou marca TAREFA/ATENCAO.
INFINITIVE_VERBS = [
    "Dar", "Pedir", "Mostrar", "Praticar", "Apresentar",
    "Corrigir", "Repetir", "Usar", "Informar", "Sugerir",
]
_A_IA_RE = re.compile(r'\bA\s+IA\b')
_STARTS_IA_RE = re.compile(r'^\s*IA\b')
_INFINITIVE_RE = re.compile(r'^\s*(?:' + '|'.join(INFINITIVE_VERBS) + r')\b', re.IGNORECASE)
_TAREFA_ATENCAO_RE = re.compile(r'TAREFA|ATEN[ÇC][ÃA]O\s*:', re.IGNORECASE)


def is_ai_instruction(text):
    return bool(
        _A_IA_RE.search(text)
        or _STARTS_IA_RE.match(text)
        or _INFINITIVE_RE.match(text)
        or _TAREFA_ATENCAO_RE.search(text)
    )

VOCAB_RE = re.compile(
    r'^(?P<term>\S(?:.{0,22}\S)?)\s[–—-]\s(?P<def>\S.{0,60})$',
    re.DOTALL,
)
DIALOGUE_TURN_RE = re.compile(r'^[A-Za-z]:\s')


def classify_task_type(text):
    lowered = text.lower()
    for task_type, patterns in TASK_TYPE_RULES:
        for pat in patterns:
            if re.search(pat, lowered):
                return task_type
    return "other"


def derive_skill(text):
    if not text:
        return None
    for sep in ("–", "—", "-"):
        if sep in text:
            candidate = text.split(sep, 1)[0].strip()
            for kw in SKILL_WHITELIST:
                if kw.lower() in candidate.lower():
                    return candidate
            break
    return None


# --- leitura do corpo do documento em ordem -----------------------------

def iter_body_blocks(document):
    """Percorre paragrafos e tabelas na ordem real do documento."""
    blocks = []
    for child in document.element.body:
        tag = child.tag.split('}')[-1]
        if tag == 'p':
            p = Paragraph(child, document)
            blocks.append({
                'kind': 'para',
                'para': p,
                'text': p.text.strip(),
                'style': p.style.name if p.style else '',
                'is_red': classify_paragraph(p),
            })
        elif tag == 'tbl':
            t = Table(child, document)
            blocks.append({'kind': 'table', 'table': t})
    return blocks


def table_to_dict(t, caption):
    rows = [[c.text.strip() for c in row.cells] for row in t.rows]
    image_dependent = False
    if len(rows) >= 2:
        data_rows = rows[1:]
        if data_rows and all((r[0].strip() == '' if r else True) for r in data_rows):
            image_dependent = True
    d = {"rows": rows}
    if caption:
        d["caption"] = caption
    d["_imageDependent"] = image_dependent
    return d


def looks_like_heading(text):
    if not text or len(text) > 100:
        return False
    if text.endswith('.') or text.endswith('?') or text.endswith('!'):
        return False
    return True


# --- extracao do preambulo (principios globais) -------------------------

def extract_preamble(blocks, end_idx, consumed, orphan_red):
    principles = []
    state = 'before'
    for i in range(0, end_idx):
        b = blocks[i]
        if b['kind'] != 'para' or not b['text']:
            continue
        if state == 'before':
            if re.search(r'PRINC[IÍ]PIOS\s+B[AÁ]SICOS', b['text'], re.IGNORECASE) and b['is_red']:
                consumed.add(i)
                state = 'collecting'
            continue
        if state == 'collecting':
            if b['is_red'] and b['style'] == 'List Paragraph':
                principles.append(b['text'])
                consumed.add(i)
            elif b['is_red']:
                orphan_red.append(b['text'])
                consumed.add(i)
                state = 'after'
            else:
                state = 'after'
            continue
        if state == 'after' and b['is_red']:
            orphan_red.append(b['text'])
            consumed.add(i)
    return principles


# --- extracao de uma secao de licao -------------------------------------

def extract_lesson(blocks, title_idx, end_idx, order, consumed):
    title_block = blocks[title_idx]
    m = TITLE_RE.fullmatch(title_block['text'])
    code = m.group('code')
    inline_subtitle = (m.group('subtitle') or '').strip() or None
    consumed.add(title_idx)

    title_text = inline_subtitle
    if title_text is None:
        for j in range(title_idx + 1, end_idx):
            b = blocks[j]
            if b['kind'] != 'para' or not b['text']:
                continue
            if b['is_red']:
                break
            if TITLE_RE.fullmatch(b['text']):
                break
            title_text = b['text']
            consumed.add(j)
            break

    skill = derive_skill(title_text)

    practice_note = None
    tasks = []
    dialogues = []
    vocabulary = []
    grammar_notes = []
    tables = []
    practice_phrases = []
    requires_images = False
    image_note = None

    current_dialogue = []

    def flush_dialogue():
        nonlocal current_dialogue
        if current_dialogue:
            dialogues.append(current_dialogue)
            current_dialogue = []

    pending_caption = None
    current_phrase_group = None

    def phrase_group(name):
        for g in practice_phrases:
            if g["group"] == name:
                return g
        g = {"group": name, "phrases": []}
        practice_phrases.append(g)
        return g

    for j in range(title_idx + 1, end_idx):
        if j in consumed:
            continue
        b = blocks[j]

        if b['kind'] == 'table':
            caption = pending_caption
            td = table_to_dict(b['table'], caption)
            if td.pop('_imageDependent'):
                requires_images = True
            tables.append(td)
            pending_caption = None
            current_phrase_group = None
            flush_dialogue()
            continue

        text = b['text']
        if not text:
            continue

        if b['is_red']:
            stripped = text.strip()
            if re.match(r'^TAREFA\b', stripped, re.IGNORECASE):
                flush_dialogue()
                pending_caption = None
                current_phrase_group = None
                trailing = re.sub(r'^TAREFA\s*:?\s*', '', stripped, flags=re.IGNORECASE).strip()
                if trailing:
                    practice_note = trailing
                consumed.add(j)
                continue

            if is_ai_instruction(text):
                flush_dialogue()
                pending_caption = None
                current_phrase_group = None
                tasks.append({
                    "order": len(tasks) + 1,
                    "instruction": text,
                    "type": classify_task_type(text),
                })
                if IMAGE_RE.search(text):
                    requires_images = True
                    if image_note is None:
                        image_note = text
                consumed.add(j)
                continue

            # vermelho, mas NAO e instrucao para a IA — e material de
            # pratica (frases de exemplo, dialogos) colorido por engano
            # ou por convencao da escola. Vai para referenceContent.
            if DIALOGUE_TURN_RE.match(text):
                if not current_dialogue and pending_caption:
                    current_dialogue.append(pending_caption)
                    pending_caption = None
                current_dialogue.append(text)
                consumed.add(j)
                continue

            flush_dialogue()

            if looks_like_heading(text):
                current_phrase_group = text
                phrase_group(text)
                consumed.add(j)
                continue

            if current_phrase_group is not None:
                phrase_group(current_phrase_group)["phrases"].append(text)
            else:
                vocabulary.append(text)
            consumed.add(j)
            continue

        # texto preto (referencia)
        current_phrase_group = None
        if DIALOGUE_TURN_RE.match(text):
            if not current_dialogue and pending_caption:
                current_dialogue.append(pending_caption)
                pending_caption = None
            current_dialogue.append(text)
            consumed.add(j)
            continue

        flush_dialogue()

        vm = VOCAB_RE.fullmatch(text)
        is_caption_like = bool(re.match(r'^DIALOGUE\b', text, re.IGNORECASE)) or (
            vm and vm.group('def').isupper()
        )
        if vm and len(text) <= 90 and not is_caption_like:
            vocabulary.append(text)
            consumed.add(j)
            pending_caption = None
            continue

        if looks_like_heading(text):
            pending_caption = text
            grammar_notes.append(text)
            consumed.add(j)
            continue

        pending_caption = None
        grammar_notes.append(text)
        consumed.add(j)

    flush_dialogue()

    lesson = {
        "code": code,
        "title": title_text,
        "skill": skill,
        "order": order,
    }
    if practice_note:
        lesson["practiceNote"] = practice_note
    lesson["tasks"] = tasks
    lesson["referenceContent"] = {
        "dialogues": dialogues,
        "vocabulary": vocabulary,
        "grammarNotes": grammar_notes,
        "tables": tables,
        "practicePhrases": [g for g in practice_phrases if g["phrases"]],
    }
    lesson["requiresImages"] = requires_images
    if requires_images and image_note:
        lesson["imageNote"] = image_note
    return lesson


# --- pipeline principal ---------------------------------------------------

def parse_book_unit_from_filename(path):
    m = re.search(r'book(\d+)-unit(\d+)', path.stem, re.IGNORECASE)
    if not m:
        return None, None
    return f"Book {int(m.group(1))}", f"Unit {int(m.group(2))}"


def infer_unit_theme(lessons):
    topics = []
    for lesson in lessons:
        t = lesson.get("title")
        if t:
            topics.append(t.split("–")[0].split("-")[0].strip())
    seen = []
    for t in topics:
        if t and t not in seen:
            seen.append(t)
    return "; ".join(seen[:12]) if seen else None


def process(docx_path: Path, out_path: Path):
    document = docx.Document(str(docx_path))
    blocks = iter_body_blocks(document)

    title_indices = []
    for i, b in enumerate(blocks):
        if b['kind'] == 'para' and b['style'] == 'Normal' and b['text']:
            if TITLE_RE.fullmatch(b['text']):
                title_indices.append(i)

    consumed = set()
    orphan_red = []

    first_title = title_indices[0] if title_indices else len(blocks)
    global_principles = extract_preamble(blocks, first_title, consumed, orphan_red)

    book, unit = parse_book_unit_from_filename(docx_path)

    lessons = []
    for idx, ti in enumerate(title_indices):
        end = title_indices[idx + 1] if idx + 1 < len(title_indices) else len(blocks)
        lesson = extract_lesson(blocks, ti, end, idx + 1, consumed)
        lessons.append(lesson)

    # varredura final: qualquer paragrafo vermelho nao consumido
    for i, b in enumerate(blocks):
        if i in consumed:
            continue
        if b['kind'] == 'para' and b['is_red'] and b['text']:
            orphan_red.append(b['text'])

    result = {
        "book": book,
        "unit": unit,
        "unitTheme": infer_unit_theme(lessons),
        "sourceFile": docx_path.name,
        "processedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "globalPrinciples": global_principles,
        "tutorIdentity": {
            "name": "Debbie Ann Pamp",
            "age": 28,
            "nationality": "Brazilian",
            "occupation": "AI Tutor",
        },
        "lessons": lessons,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    return result, orphan_red


def print_report(result, orphan_red):
    lessons = result["lessons"]
    print(f"\n=== RELATORIO — {result['sourceFile']} ===")
    print(f"Licoes extraidas: {len(lessons)}")
    print("Codigos:", ", ".join(l["code"] for l in lessons))

    total_tasks = sum(len(l["tasks"]) for l in lessons)
    print(f"\nTotal de tarefas: {total_tasks}")

    dist = {}
    for l in lessons:
        for t in l["tasks"]:
            dist[t["type"]] = dist.get(t["type"], 0) + 1
    print("Distribuicao por tipo:")
    for k, v in sorted(dist.items(), key=lambda kv: -kv[1]):
        print(f"  {k}: {v}")

    with_images = [l["code"] for l in lessons if l["requiresImages"]]
    print(f"\nLicoes com requiresImages=true: {', '.join(with_images) if with_images else '(nenhuma)'}")

    thin = [l["code"] for l in lessons if len(l["tasks"]) == 0]
    print(f"Licoes sem nenhuma tarefa: {', '.join(thin) if thin else '(nenhuma)'}")
    few = [l["code"] for l in lessons if 0 < len(l["tasks"]) <= 1]
    print(f"Licoes com apenas 1 tarefa: {', '.join(few) if few else '(nenhuma)'}")

    no_skill = [l["code"] for l in lessons if not l.get("skill")]
    print(f"\nLicoes sem 'skill' identificado (titulo sem rotulo reconhecivel): {', '.join(no_skill) if no_skill else '(nenhuma)'}")
    no_title = [l["code"] for l in lessons if not l.get("title")]
    print(f"Licoes sem 'title' (nenhum subtitulo encontrado no documento): {', '.join(no_title) if no_title else '(nenhuma)'}")

    print(f"\nTrechos vermelhos nao associados a nenhuma licao ({len(orphan_red)}):")
    for t in orphan_red:
        print(f"  - {t[:120]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("docx_path")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    docx_path = Path(args.docx_path)
    if args.out:
        out_path = Path(args.out)
    else:
        book, unit = parse_book_unit_from_filename(docx_path)
        m = re.search(r'(book\d+-unit\d+)', docx_path.stem, re.IGNORECASE)
        base = m.group(1).lower() if m else docx_path.stem
        out_path = Path("src/app-config/curriculum") / f"{base}.json"

    result, orphan_red = process(docx_path, out_path)
    print(f"JSON gerado em: {out_path}")
    print_report(result, orphan_red)


if __name__ == "__main__":
    sys.exit(main())
