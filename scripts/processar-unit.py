#!/usr/bin/env python
"""
Extrai um book/unit do formato .docx da escola (instrucoes em vermelho
#EE0000, conteudo de referencia em preto) para o JSON de curriculum
consumido pela Tutora.

Cada licao vira uma lista de TASKS (o paragrafo vermelho que diz o que a
Debbie faz) e cada task uma lista de ITENS que ela percorre:
    { label?, prompt, expectedAnswer, reply?, image? }
  - "Tutor/Debbie: X" + "Student: Y"      -> prompt X, expectedAnswer Y
  - "Student: Y" + "Tutor: Z" (aluno abre) -> expectedAnswer Y, reply Z
  - linha de tabela: dica | "Answer: ..." | foto -> prompt, expectedAnswer, image
  - lista simples (verbos, frases, roupas)  -> prompt
A imagem de um item vem da mesma linha da tabela, do mesmo paragrafo ou do
paragrafo vazio logo abaixo. Imagem flutuante fora de tabela, ou de texto
de referencia sem task que mostre imagens, NAO e adivinhada: vai para
"pendingImages" da licao.

Uso:
    python scripts/processar-unit.py material_do_curso/originais/book01/book01-unit01.docx
    python scripts/processar-unit.py <docx> --out <destino.json> --report <analise.md> --html <conferencia.html>
    python scripts/processar-unit.py <docx> --out <destino.json> --images <pasta>   (carga: scripts/carregar-material.cjs)
"""
import argparse
import base64
import datetime
import html
import io
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

# Um titulo real e uma linha inteira (preta) no formato:
#   [<prefixo curto terminado em travessao> | Book N] Lesson(s) <codigo> [ - <subtitulo>]
# Ex.: "Boas-vindas - Lesson A", "Unit 1 - Lesson 3B - Countries and Continents",
#      "Summary - Book 1 - Unit 1 - Lesson 3E", "Unit 3 – Lesson 11 A",
#      "Unit 3 – Lesson 13 A Presentation and Grammar", "Book 1 Lesson 16 C",
#      "The Way for AI – Book 2 – Unit 2 – Lesson 6A", "UNIT 4 – LESSON 19 C"
TITLE_RE = re.compile(
    r'^(?:.{0,40}?[–—-]\s*|(?i:book)\s+\d+\s+)?'
    r'(?i:lessons?)\s+(?P<code>\d+(?:\s?[A-Z]{1,3})?(?![A-Za-z])|[A-Za-z](?![A-Za-z]))'
    r'(?:\s*[–—-]\s*(?P<subtitle>.+?)|\s+(?P<subtitle2>[A-Z][^.?!]*?))?\s*$',
    re.DOTALL,
)

SKILL_WHITELIST = [
    "Speaking", "Vocabulary", "Grammar", "Pronunciation",
    "Listening", "Reading", "Writing", "Review", "Presentation",
]

TASK_TYPE_RULES = [
    # (tipo, padroes regex verificados em ordem de prioridade). O tipo diz o
    # que o ALUNO faz na tarefa — "A IA mostra as imagens e pede pro aluno
    # repetir" e student_repeats, nao demonstrate. Os padroes rodam sobre o
    # texto em minusculas; a ordem resolve os casos com mais de um verbo
    # ("mostra que se usa mais a pergunta..." e explain, nao student_answers).
    ("explain", [r"\bexplica", r"come[çc]a\s+falando", r"mostra\s+que\s+se\s+usa", r"\bexplains\b"]),
    ("review", [
        r"repete\s+aleatoriamente\s+todas", r"\brevis[ãa]o\b", r"\brevisando\b",
        r"repeats\s+all\s+the\s+tasks", r"\brevising\b",
    ]),
    ("repeat_activity", [r"repeats\s+the\s+(?:activity|procedure)"]),
    ("demonstrate", [r"reads\s+the\s+text", r"presents\s+the\s+following\s+dialogue"]),
    ("student_leads", [
        r"alunos?\s+(?:iniciar|iniciarem|come[çc]ar|come[çc]arem)\s+o\s+(?:\w+\s+)?di[aá]logo",
        r"alunos?\s+perguntar",
        r"perguntando\s+[àa]\s+ia",
        r"student\s+to\s+start", r"student\s+(?:starts|has\s+to\s+ask)", r"trade\s+places",
    ]),
    # "repetir a atividade" e oferecer repeticao, nao pedir para repetir
    ("student_repeats", [
        r"\brepetir(?:em)?\b(?!\s+(?:a\s+atividade|o\s+exerc))", r"\brepita[mn]?\b",
        r"\bto\s+repeat\b",
    ]),
    ("student_reads", [r"\bler\b", r"\blerem\b", r"\bl[êèe]-l[ao]s?\b", r"\bto\s+(?:read|pronounce)\b"]),
    ("translate", [r"\btranslat", r"\btraduzir\b"]),
    ("student_answers", [
        r"\bperguntas?\b",
        r"pede.{0,40}\b(?:dizer|completar|completer|formar|identificar)\b",
        r"pedindo.{0,40}\b(?:dizer|completar|formar|identificar)\b",
        r"\binicia\s+(?:o\s+|os\s+)?di[aá]logos?\b",
        r"\bresponde\b",
        r"\basks\b", r"\basking\b", r"\bquestions?\b", r"\btells\s+the\s+student\b",
        r"\bto\s+(?:describe|complete|say|form|tell|transform|conjugate|correct|talk|give|substitute)\b",
    ]),
    ("roleplay", [r"sugere\s+v[aá]rios\s+di[aá]logos", r"take\s+turns", r"whole\s+dialogue", r"similar\s+dialogue"]),
    ("offer_repeat", [
        r"op[çc][ãa]o.{0,20}repetir",
        r"(?:quiser|queira)\s+(?:repetir|fazer\s+mais|praticar\s+mais)",
    ]),
    ("demonstrate", [
        r"\bmostra\b", r"\bapresenta\b", r"\bl[êe]\b", r"\bpronuncia\b", r"\bpratica\b",
        r"\bshows\b", r"\bexpresses\b", r"\bsays\b",
    ]),
    ("correct", [r"corrigindo", r"\bcorrigir\b"]),
]

_IMAGE_WORD = r"(?:image[mn]s?|pictures?|photos?|calendars?)"
IMAGE_RE = re.compile(r"\b" + _IMAGE_WORD + r"\b", re.IGNORECASE)
# Tarefa que poe imagens na tela ("A IA mostra as imagens", "Debbie shows
# the pictures", "describe these pictures") — e a dona das imagens do texto
# de referencia logo abaixo dela. "usar as mesmas imagens" so reaproveita.
SHOWS_IMAGES_RE = re.compile(
    r"\b(?:mostra|mostrando|apresenta|apresentando|shows|showing|presents|according\s+to|describe|look\s+at)\b"
    r".{0,40}\b" + _IMAGE_WORD + r"\b",
    re.IGNORECASE,
)
SAME_IMAGES_RE = re.compile(r"\bmesmas\s+imagens\b|\bsame\s+pictures\b|pictures\s+from\s+the\s+previous", re.IGNORECASE)

# Dependencia de imagem POR TAREFA (campo "imageDependency" de cada task):
#   "oral"       — a instrucao nao fala de imagem e nenhum item tem imagem.
#   "visual"     — a instrucao usa imagem ou algum item tem imagem. Sem a
#                  imagem carregada, a rota roda so a parte falada.
#   "image-only" — nada sobra sem a imagem (identificar o simbolo). Pulada
#                  enquanto nao houver imagem, e fora do denominador.
# Heuristica: REVISAR o relatorio (--report) a cada unit nova.
_IMAGE_ONLY_RES = [
    re.compile(r"identificar\b.*s[íi]mbolo", re.IGNORECASE),
]


def classify_image_dependency(text, has_item_images=False):
    if any(r.search(text) for r in _IMAGE_ONLY_RES):
        return "image-only"
    if has_item_images or IMAGE_RE.search(text):
        return "visual"
    return "oral"


# Repeticoes pedidas na instrucao, copiadas literalmente para o relatorio
# ("(2x cada símbolo)", "pelo mesno 10 vezes", "Após 3 tentativas", "6 questions").
REPETITION_RES = [
    re.compile(r"\(\s*\d+\s*x[^)]*\)", re.IGNORECASE),
    re.compile(r"n[ãa]o\s+mais\s+do\s+que\s+\d+\s*x", re.IGNORECASE),
    re.compile(r"pelo\s+\S+\s+(?:\d+|uma|duas|tr[êe]s)\s+vez(?:es)?(?:\s+com\s+cada\s+\w+)?", re.IGNORECASE),
    re.compile(r"ap[óo]s\s+\d+\s+tentativas", re.IGNORECASE),
    re.compile(r"\b\d+\s*x\b(?![^(]*\))", re.IGNORECASE),
    re.compile(r"\b\d+\s+(?:times|questions|of\s+the\s+topics)\b", re.IGNORECASE),
    re.compile(r"\bat\s+least\s+\w+(?:\s+time)?", re.IGNORECASE),
    re.compile(r"\b(?:fewer|menos)\s+(?:times|vezes)\b", re.IGNORECASE),
]


def extract_repetitions(text):
    found = []
    for r in REPETITION_RES:
        for m in r.finditer(text):
            frag = m.group(0).strip()
            if not any(frag in f for f in found):
                found.append(frag)
    return found


# --- o que e cada paragrafo vermelho -------------------------------------

# Marcador "TAREFA" (as vezes "TABELA", por engano) que abre o bloco de
# tasks; o que vier na mesma linha e nota geral da licao (practiceNote).
TAREFA_RE = re.compile(r'^\s*(?P<word>TAREFA|TABELA)\b\s*:?\s*(?P<rest>.*)$', re.IGNORECASE | re.DOTALL)
# "Sem tarefa oral nessa lição", "Nenhuma tarefa para essa lição",
# "SEM TAREFAS NESSA LIÇÃO", "Não há TAREFA para essa lição"
NO_TASK_RE = re.compile(r'^\s*(?:sem|nenhuma|n[ãa]o\s+h[áa])\s+(?:tarefas?|tasks?)\b', re.IGNORECASE)

# Uma task NOVA comeca pelo ator + verbo de acao ("The AI Tutor asks",
# "Debbie shows", "A IA pergunta", "Then, the AI Tutor suggests", "After
# practicing Part 1, Debbie asks") ou por um imperativo ("Ask the student",
# "Translate...", "Pedir para os alunos..."). Ator no MEIO da frase ("The
# answers will vary. Debbie corrects...") e nota da task atual, assim como
# condicionais ("If...", "Caso o aluno...") e "Note:".
_ACTION_VERBS = (
    "asks|shows|says|tells|explains|repeats|presents|corrects|expresses|reads|suggests|starts|"
    "plays|describes|gives|uses|introduces|"
    "pergunta|pede|mostra|apresenta|lê|le|inicia|explica|sugere|pratica|corrige|repete|começa|comeca|"
    "fala|diz|dá|da"
)
ACTOR_START_RE = re.compile(
    r'^\s*(?:(?:then|now|first|finally|after\s[^,]{1,60}),\s*)?'
    r'(?:(?:the\s+)?(?:ai(?:\s+tutor)?|tutor|debbie)\s+(?:' + _ACTION_VERBS + r')\b(?!\s+\d)'
    # "A IA <verbo>" em portugues: qualquer verbo ("A IA pronuncia", "A IA Lê")
    r'|(?:a\s+ia|ia|o\s+a\s+ia)\s+(?!e\b|é\b)[a-zà-úê]{2,})',
    re.IGNORECASE,
)
IMPERATIVE_START_RE = re.compile(
    r'^\s*(?:ask|show|translate|pedir|mostrar|praticar|apresentar|corrigir|repetir|usar|informar|'
    r'sugerir|perguntar|mostra|pede|pergunta|apresenta|inicia)\b',
    re.IGNORECASE,
)
NOTE_START_RE = re.compile(
    r'^\s*(?:\*|note\b|nota\b|obs\b|aten[çc][ãa]o\b|if\b|caso\b|se\b|it\s+is\b|for\s+the\s+answer|'
    r'the\s+answers?\b|the\s+words\s+are|then\b|after\b|o\s+aluno\b|os\s+alunos\b|for\s+example|'
    r'por\s+exemplo|etc\.?\s*$|other\s+possible|you\s+can\b|(?:debbie|the\s+ai|the\s+tutor)\s+\w+\s+\d)',
    re.IGNORECASE,
)
_PORTUGUESE_RE = re.compile(
    r'\b(?:alunos?|pede|pedir|pedindo|mostra|mostrar|mostrando|apresenta|apresentar|'
    r'pratica|praticar|caso|usar|usando|responde|corrigindo|corrigir|repetir|'
    r'imagens?|li[çc][ãa]o|li[çc][õo]es|tarefas?|sugerir|informar|perguntar)\b',
    re.IGNORECASE,
)
_INSTRUCTION_WORDS_RE = re.compile(r'\b(?:student|tutor|debbie|the\s+ai)\b', re.IGNORECASE)

# Falas: "Tutor: X", "Debbie: X", "Tutor (showing time on the screen): X",
# "Student: Y", "Student:: Y", "Tutor. X" (ponto por engano), "B: Y",
# "Question: X" / "Answer: Y".
SPEAKER_RE = re.compile(
    r'^\s*(?P<who>the\s+ai\s+tutor|ai\s+tutor|tutor|debbie|ia|student|aluno|question|answer|[AB])'
    r'\s*(?:\([^)]*\))?\s*(?P<delim>::?|\.(?=\s))\s*(?P<rest>.*)$',
    re.IGNORECASE | re.DOTALL,
)
_DEBBIE_WHO = {"the ai tutor", "ai tutor", "tutor", "debbie", "ia", "question", "a"}
# Rotulo de item: "A1.", "B1 –", "a.1", "b1.", "1.", "10."
LABEL_RE = re.compile(r'^\s*(?P<label>[A-Za-z]\.?\d{1,2}|\d{1,2}[.)])\s*(?:[.)]|[–—-])?\s+(?P<rest>\S.*)$', re.DOTALL)
# Cabecalho de grupo dentro da lista de itens ("Rising-falling intonation",
# "Singular", "Plural", "Note about prices").
GROUP_RE = re.compile(
    r'^\s*(?:rising[- ]falling\s+intonation|rising\s+intonation|falling\s+intonation|singular|plural|note\s+about\s+\w+)\s*:?\s*$',
    re.IGNORECASE,
)
_LABEL_WORDS = {"tutor", "student", "debbie", "ai tutor", "aluno", "ia"}
EXAMPLES_RE = re.compile(r'\bfor\s+example\b|\bpor\s+exemplo\b|\be\.g\.|\betc\b', re.IGNORECASE)


def split_label(text):
    m = LABEL_RE.match(text)
    if m:
        return m.group('label').rstrip('.)'), m.group('rest').strip()
    return None, text.strip()


def split_speaker(text):
    m = SPEAKER_RE.match(text)
    if not m:
        return None, text
    who = m.group('who').lower()
    if m.group('delim') == '.' and who != 'tutor':
        return None, text
    # "A"/"B" so como fala quando maiusculo, com dois-pontos e texto depois
    # ("A IA..." nao e fala; nem o simbolo fonetico "a:")
    if who in ('a', 'b') and (m.group('delim') != ':' or not m.group('who').isupper() or not m.group('rest').strip()):
        return None, text
    return ('debbie' if who in _DEBBIE_WHO else 'student'), m.group('rest').strip()


def is_new_task(text, current_instruction=""):
    label, rest = split_label(text)
    if split_speaker(rest)[0] is not None:
        return False
    # "2) The AI Tutor corrects..." continua a lista "Note: 1) ..." da task
    if label and label.isdigit() and re.search(r'(?:^|\s)1\)', current_instruction):
        return False
    return bool(ACTOR_START_RE.match(rest) or IMPERATIVE_START_RE.match(rest))


def is_task_note(text):
    """Vermelho que completa a task atual em vez de ser item: condicionais,
    "Note:", e instrucao escrita em portugues ou que fala do aluno/tutor."""
    label, rest = split_label(text)
    if split_speaker(rest)[0] is not None:
        return False
    # linha numerada ("b4. If we ask anything...") e item; so "2) ..." continua
    # uma nota "Note: 1) ..."
    if label and not re.match(r'^\s*\d+\)', text):
        return False
    if NOTE_START_RE.match(rest):
        return True
    if _PORTUGUESE_RE.search(rest) and re.search(r'\b(?:aluno|alunos|IA|Debbie)\b', rest):
        return True
    return len(rest) > 60 and bool(_INSTRUCTION_WORDS_RE.search(rest)) and not rest.rstrip().endswith('?')


def is_ai_instruction(text):
    """Compat: paragrafo vermelho que e instrucao (task nova ou nota)."""
    return is_new_task(text) or is_task_note(text)


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

_R_EMBED = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed'


def block_images(element, document):
    """Imagens embutidas no bloco, em ordem: {"media": nome da parte dentro do
    .docx (ex.: "word/media/image12.png"), "crop": recorte ou None,
    "floating": True se ancorada (wp:anchor) em vez de em linha}. O r:embed de
    cada a:blip e resolvido pelos relacionamentos do documento. A escola as
    vezes cola UMA imagem composta varias vezes, cada uma recortada num
    quadrante (as quatro idades de Jesus na 2F) — o recorte (a:srcRect, em
    fracao 0-1 de cada borda) faz parte da identidade da imagem."""
    found = []
    for blip in element.xpath('.//*[local-name()="blip"]'):
        rid = blip.get(_R_EMBED)
        part = document.part.related_parts.get(rid) if rid else None
        if part is None:
            continue
        crop = None
        rects = blip.getparent().xpath('./*[local-name()="srcRect"]')
        if rects and rects[0].attrib:
            crop = {k: int(v) / 100000 for k, v in rects[0].attrib.items() if k in ('l', 't', 'r', 'b')}
        holder = blip.xpath('ancestor::*[local-name()="anchor" or local-name()="inline"]')
        floating = bool(holder) and holder[-1].tag.endswith('}anchor')
        img = {"media": str(part.partname).lstrip('/'), "crop": crop, "floating": floating}
        if not any(i["media"] == img["media"] and i["crop"] == img["crop"] for i in found):
            found.append(img)
    return found


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
                'images': block_images(child, document),
            })
        elif tag == 'tbl':
            t = Table(child, document)
            blocks.append({'kind': 'table', 'table': t, 'images': block_images(child, document)})
    return blocks


def table_cells(t, document):
    """Linhas da tabela como listas de celulas {lines: [(texto, vermelho)],
    images}, sem repetir celulas mescladas."""
    rows = []
    for row in t.rows:
        seen = set()
        cells = []
        for c in row.cells:
            if id(c._tc) in seen:
                continue
            seen.add(id(c._tc))
            lines = [(p.text.strip(), classify_paragraph(p)) for p in c.paragraphs if p.text.strip()]
            cells.append({"lines": lines, "images": block_images(c._tc, document)})
        rows.append(cells)
    return rows


def table_is_red(rows):
    flags = [red for row in rows for c in row for _, red in c["lines"]]
    return bool(flags) and sum(flags) * 2 > len(flags)


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


# --- itens de uma task ----------------------------------------------------

def _image_ref(img):
    return {"media": img["media"], "crop": img["crop"]}


def _same_image(a, b):
    return a["media"] == b["media"] and a["crop"] == b["crop"]


class TaskItems:
    """Monta a lista de itens de uma task a partir das linhas vermelhas que
    vem logo abaixo da instrucao, na ordem do documento."""

    def __init__(self, task):
        self.task = task
        self.items = task["items"]
        self.group = None

    def _new(self, label=None, prompt="", expected=None, **extra):
        item = {"prompt": prompt, "expectedAnswer": expected}
        label = label or self.group
        if label:
            item = {"label": label, **item}
        item.update(extra)
        self.items.append(item)
        return item

    def last(self):
        return self.items[-1] if self.items else None

    def add_line(self, text, raw=None):
        """Uma linha vermelha que nao e task nova nem nota. Devolve o item
        criado ou completado (para receber a imagem do paragrafo). `raw` e o
        texto sem strip: recuo no inicio = continuacao da fala anterior."""
        if GROUP_RE.match(text):
            self.group = text.strip().rstrip(':')
            return None
        label, rest = split_label(text)
        who, content = split_speaker(rest)
        last = self.last()
        student_leads = self.task["type"] == "student_leads"

        if who == 'debbie':
            # aluno abriu o dialogo (ou a Debbie so deu a dica: "Tutor: book"):
            # a fala seguinte da Debbie e a resposta dela
            cue = last is not None and (last.get("_plain") or (
                len(last["prompt"].split()) <= 3 and not last["prompt"].rstrip().endswith('?')))
            if last and last.get("_studentFirst") and last["expectedAnswer"] and "reply" not in last:
                last["reply"] = content
                last["_lastWho"] = None
                return last
            if (student_leads and cue and last["expectedAnswer"] and "reply" not in last
                    and not last.get("_await")):
                last["reply"] = content
                last["_lastWho"] = None
                return last
            # dica numa linha ("2. tomatoes") e a pergunta da Debbie na seguinte
            if last and last.get("_plain") and last["expectedAnswer"] is None and not last.get("image") and content:
                last["label"] = " ".join(x for x in (last.get("label"), last["prompt"]) if x)
                last["prompt"] = content
                last.pop("_plain")
                return last
            # "Tutor:" vazio logo depois de uma pergunta sem resposta: as
            # linhas seguintes completam essa pergunta (exemplo de conjugacao)
            if not content and not label and last and last["expectedAnswer"] is None and last["prompt"]:
                last["_await"] = "prompt"
                return last
            item = self._new(label, content, _lastWho="debbie")
            if not content:
                item["_await"] = "prompt"
            return item

        if who == 'student':
            # fala generica depois de uma lista "What time do you…" (12C):
            # exemplo de resposta para a lista toda, nao do ultimo item
            tpl = [i for i in self.items if i.get("_tpl")]
            if last and last.get("_tpl") and len(tpl) >= 2 and all(i["expectedAnswer"] is None for i in tpl):
                self.task["instruction"] += "\n" + text
                return None
            if last and last["expectedAnswer"] is None and "reply" not in last and not last.get("_studentFirst"):
                last["expectedAnswer"] = content
                last["_lastWho"] = "student"
                last.pop("_await", None)
                if not content:
                    last["_await"] = "answer"
                return last
            item = self._new(label, "", content, _studentFirst=True)
            if not content:
                item["_await"] = "answer"
            item["_lastWho"] = "student"
            return item

        # linha sem fala, recuada, no meio de um dialogo: continua a fala anterior
        if last and not label and raw and re.match(r'^(?:\t|\s{2,})', raw) and last.get("_lastWho"):
            field = "expectedAnswer" if last["_lastWho"] == "student" else "prompt"
            last[field] = ((last[field] or "") + "\n" + rest).strip()
            return last

        # linha sem fala
        if last and last.get("_await") == "prompt" and not label:
            last["prompt"] = (last["prompt"] + "\n" + rest).strip()
            return last
        if last and last.get("_await") == "answer" and not label:
            last["expectedAnswer"] = (last["expectedAnswer"] + "\n" + rest).strip()
            return last
        # "Please, conjugate the verb TO DO." seguido da conjugacao sem "Student:"
        if last and not label and re.search(r'\bconjugate\b', last["prompt"], re.IGNORECASE):
            if last["expectedAnswer"] is None:
                last["expectedAnswer"] = rest
            else:
                last["expectedAnswer"] += "\n" + rest
            return last
        # "Tutor: What time do you…" seguido de opcoes: cada opcao completa a pergunta
        if last and not label and last["expectedAnswer"] is None and re.search(r'(?:…|\.\.\.)\s*$', last["prompt"]):
            template = last["prompt"]
            if not last.get("image") and not last.get("_tpl"):
                self.items.pop()
            item = self._new(None, f"{template.rstrip()} {rest}", None, _tpl=True)
            item["_template"] = template
            return item
        if last and last.get("_tpl") and not label and last["expectedAnswer"] is None:
            return self._new(None, f"{last['_template'].rstrip()} {rest}", None, _tpl=True, _template=last["_template"])
        return self._new(label, rest, _plain=True)

    def add_image_item(self, img):
        return self._new(None, "", None, image=_image_ref(img))


def finalize_items(items):
    for item in items:
        for k in [k for k in item if k.startswith('_')]:
            del item[k]
        if item.get("expectedAnswer") == "":
            item["expectedAnswer"] = None


def parse_table_items(rows, add_item, add_note):
    """Itens de uma tabela vermelha, linha por linha. Cobre os formatos da
    escola: dica + "Answer:" | foto (B2U2 6A); "Debbie: X / Student: Y" | foto;
    foto | resposta, com a pergunta num cabecalho ("Debbie: What's the weather
    like?") ou com colunas DEBBIE | STUDENT; linha-modelo ("Debbie | Yes, I
    can. OR No, I can't."); grade transposta (linha TUTOR com fotos e
    perguntas, linha STUDENT com as respostas, B1U4 16A); e quadro de palavras
    por coluna (sons em B1U5 21C)."""
    def cell_text(c):
        return "\n".join(t for t, _ in c["lines"])

    def is_label_cell(c):
        return bool(c["lines"]) and all(t.strip().lower() in _LABEL_WORDS for t, _ in c["lines"])

    def is_label_row(row):
        filled = [c for c in row if c["lines"] or c["images"]]
        return bool(filled) and all(is_label_cell(c) and not c["images"] for c in filled)

    def row_images(row):
        out = []
        for c in row:
            for img in c["images"]:
                if not any(_same_image(img, o) for o in out):
                    out.append(img)
        return out

    # icones repetidos em varias celulas (o "+" da 16A) nao sao a foto do item
    counts = {}
    for row in rows:
        for c in row:
            for img in c["images"]:
                counts[img["media"]] = counts.get(img["media"], 0) + 1

    def split_main(imgs):
        if len(imgs) <= 1:
            return (imgs[0] if imgs else None), []
        unique = [i for i in imgs if counts.get(i["media"], 0) == 1]
        main = unique[0] if unique else imgs[0]
        return main, [i for i in imgs if i is not main]

    def emit(label, prompt, expected, imgs, reply=None):
        main, extra = split_main(imgs)
        item = {"prompt": prompt or "", "expectedAnswer": expected or None}
        if label:
            item = {"label": label, **item}
        if reply:
            item["reply"] = reply
        if main:
            item["image"] = _image_ref(main)
        if extra:
            item["extraImages"] = [_image_ref(i) for i in extra]
        add_item(item)

    # grade transposta: linhas-rotulo TUTOR / STUDENT alternando
    label_rows = [i for i, r in enumerate(rows) if is_label_row(r)]
    if len(label_rows) >= 2 and any(cell_text(rows[i][0]).strip().lower() == "student" for i in label_rows):
        i = 0
        while i < len(rows):
            if is_label_row(rows[i]) and cell_text(rows[i][0]).strip().lower() != "student" and i + 1 < len(rows):
                q = rows[i + 1]
                a = rows[i + 3] if i + 3 < len(rows) and is_label_row(rows[i + 2]) else []
                for col, qc in enumerate(q):
                    ac = a[col] if col < len(a) else {"lines": [], "images": []}
                    if not qc["lines"] and not qc["images"]:
                        continue
                    imgs = qc["images"] + [x for x in ac["images"] if not any(_same_image(x, y) for y in qc["images"])]
                    emit(None, cell_text(qc), cell_text(ac), imgs)
                i += 4
            else:
                i += 1
        return

    roles = None
    template_prompt = None
    default_expected = None
    start = 0
    if rows and is_label_row(rows[0]):
        roles = ["debbie" if cell_text(c).strip().lower() in ("tutor", "debbie", "ai tutor", "ia") else "student"
                 for c in rows[0]]
        start = 1
    imaged_rows = sum(1 for r in rows if row_images(r))

    # quadro de palavras por coluna (cabecalho de sons, sem fotos nem falas)
    if (not roles and not imaged_rows and len(rows) > 1 and len(rows[0]) >= 3
            and all(c["lines"] for c in rows[0])
            and not any(split_speaker(t)[0] for r in rows for c in r for t, _ in c["lines"])):
        heads = [cell_text(c) for c in rows[0]]
        for col, head in enumerate(heads):
            for r in rows[1:]:
                if col < len(r) and r[col]["lines"]:
                    emit(head, cell_text(r[col]), None, [])
        return

    for ri in range(start, len(rows)):
        row = rows[ri]
        imgs = row_images(row)
        texts = [cell_text(c) for c in row]
        if not any(texts) and not imgs:
            continue
        lines = [t for c in row for t, _ in c["lines"]]
        label = None
        if lines:
            label, first = split_label(lines[0])
            lines[0] = first

        # linha-modelo: "Debbie | Yes, I can. OR No, I can't." (B2U1 2A)
        if roles and not imgs and row and is_label_cell(row[0]) and any(texts[1:]):
            default_expected = next(t for t in texts[1:] if t)
            continue

        spoken = [split_speaker(t) for t in lines]
        if any(who for who, _ in spoken) or any(re.match(r'^\s*answer\s*:', t, re.I) for t in lines):
            # cabecalho "Debbie: What's the weather like? | Student: It's …" sem foto
            if ri == 0 and not imgs and imaged_rows >= max(1, (len(rows) - 1) // 2):
                template_prompt = next((c for w, c in spoken if w == 'debbie'), None)
                add_note("\n".join(t for c in row for t, _ in c["lines"]))
                continue
            prompt, expected, reply, cue = [], [], [], []
            student_first = spoken and spoken[0][0] == 'student'
            for who, content in spoken:
                if who == 'debbie':
                    (reply if student_first and expected else prompt).append(content)
                elif who == 'student':
                    expected.append(content)
                elif expected:
                    expected.append(content)
                elif prompt:
                    prompt.append(content)
                else:
                    cue.append(content)
            emit(label, "\n".join(cue + prompt), "\n".join(expected), imgs, "\n".join(reply))
            continue

        if roles:
            deb = "\n".join(texts[i] for i, r in enumerate(roles) if r == "debbie" and i < len(texts) and texts[i])
            stu = "\n".join(texts[i] for i, r in enumerate(roles) if r == "student" and i < len(texts) and texts[i])
            emit(label, (split_label(deb)[1] if deb else template_prompt or ""), stu or default_expected, imgs)
            continue

        filled = [t for t in texts if t]
        if len(filled) >= 2:
            emit(label, split_label(filled[0])[1], "\n".join(filled[1:]), imgs)
        elif filled and template_prompt:
            emit(label, template_prompt, filled[0], imgs)
        elif filled:
            # foto a esquerda e frase a direita ("[foto] | That baby can't
            # walk."): a frase e o que o aluno diz; frase a esquerda e foto a
            # direita ("Go straight ahead... | [foto]") e a dica da Debbie
            img_col = next((k for k, c in enumerate(row) if c["images"]), None)
            txt_col = next(k for k, t in enumerate(texts) if t)
            cell_lines = filled[0].split("\n")
            if cell_lines[0].rstrip().endswith('?') and len(cell_lines) > 1:
                emit(label, split_label(cell_lines[0])[1], "\n".join(cell_lines[1:]), imgs)
            elif img_col is not None and img_col < txt_col:
                emit(label, "", filled[0], imgs)
            else:
                emit(label, split_label(filled[0])[1], None, imgs)
        else:
            emit(None, template_prompt or "", None, imgs)


def _reference_text(lines):
    """Texto de uma linha/celula preta: "Q: pergunta" ou uma pergunta seguida
    da resposta viram prompt + expectedAnswer; o resto vai inteiro no prompt."""
    if not lines:
        return {"prompt": "", "expectedAnswer": None}
    spoken = [split_speaker(t) for t in lines]
    if any(w for w, _ in spoken):
        prompt = "\n".join(c for w, c in spoken if w != 'student')
        expected = "\n".join(c for w, c in spoken if w == 'student') or None
        return {"prompt": prompt, "expectedAnswer": expected}
    first = re.sub(r'^\s*Q\s*:\s*', '', lines[0])
    if first.rstrip().endswith('?') and len(lines) > 1:
        return {"prompt": first, "expectedAnswer": "\n".join(lines[1:])}
    return {"prompt": " | ".join([first] + lines[1:]), "expectedAnswer": None}


def reference_row_items(rows):
    """Itens de uma tabela PRETA com fotos, para a task que mostra imagens
    (Unit 1: a tabela de idades da 2F, a grade de profissoes da 4AB). So as
    linhas com foto. Grade com foto e legenda na MESMA celula: um item por
    celula; senao, o texto da linha vale para a(s) foto(s) dela."""
    out = []
    for row in rows:
        imgs = [img for c in row for img in c["images"]]
        if not imgs:
            continue
        own = [c for c in row if c["images"] and c["lines"]]
        if len(own) >= 2:
            for c in row:
                if c["images"]:
                    item = _reference_text([t for t, _ in c["lines"]])
                    out += [(dict(item), img) for img in c["images"]]
            continue
        item = _reference_text([t for c in row for t, _ in c["lines"]])
        out += [(dict(item), img) for img in imgs]
    return out


# --- extracao de uma secao de licao -------------------------------------

def extract_lesson(blocks, title_idx, end_idx, order, consumed, document):
    title_block = blocks[title_idx]
    m = TITLE_RE.fullmatch(title_block['text'])
    code = re.sub(r'\s+', '', m.group('code'))
    inline_subtitle = (m.group('subtitle') or m.group('subtitle2') or '').strip() or None
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
    no_tasks_note = None
    used_tabela = False
    tasks = []
    dialogues = []
    vocabulary = []
    grammar_notes = []
    tables = []
    practice_phrases = []
    requires_images = False
    image_note = None
    pending = []

    current_dialogue = []

    def flush_dialogue():
        nonlocal current_dialogue
        if current_dialogue:
            dialogues.append(current_dialogue)
            current_dialogue = []

    pending_caption = None
    current_phrase_group = None

    # Task aberta: recebe os itens e notas vermelhos logo abaixo dela; fecha
    # no primeiro texto/tabela preto (in_block = False).
    cur = None
    builder = None
    in_block = False
    last_item = None
    # Dona das imagens do texto de referencia: a ultima task ACIMA que MOSTRA
    # imagens (SHOWS_IMAGES_RE) — num bloco de tarefas seguidas, a primeira
    # delas (licao A: duas tarefas usam a mesma tabela de simbolos).
    image_task = None
    image_task_in_run = False

    def all_item_images():
        return [i["image"] for t in tasks for i in t["items"] if i.get("image")] + \
               [x for t in tasks for i in t["items"] for x in i.get("extraImages", [])]

    def add_pending(img, reason, suggested=None):
        ref = _image_ref(img)
        # copia (inteira ou com outro recorte) de uma foto que ja esta num item
        if any(ref["media"] == x["media"] for x in all_item_images()):
            return
        if any(_same_image(ref, p) for p in pending):
            return
        entry = {**ref, "reason": reason}
        if suggested:
            entry["suggestedTask"] = suggested
        pending.append(entry)

    def new_task(text):
        nonlocal cur, builder, in_block, last_item, image_task, image_task_in_run, requires_images, image_note
        task = {
            "order": len(tasks) + 1,
            "instruction": text,
            "type": classify_task_type(text),
            "imageDependency": "oral",
            "items": [],
        }
        tasks.append(task)
        cur, builder, in_block, last_item = task, TaskItems(task), True, None
        if IMAGE_RE.search(text):
            requires_images = True
            if SHOWS_IMAGES_RE.search(text) and not SAME_IMAGES_RE.search(text) and not image_task_in_run:
                image_task = task
                image_task_in_run = True
            if image_note is None:
                image_note = text
        return task

    def task_has_own_images(task):
        return any(i.get("image") and not i.get("fromReference") for i in task["items"])

    def reference_image(img, prompt_text):
        """Imagem no texto de referencia (preto). Flutuante nao e adivinhada —
        exceto recorte de uma imagem composta (as idades de Jesus da 2F): o
        recorte em si separa as fotos, um item por recorte."""
        if img["floating"] and not (img["crop"] and image_task and not task_has_own_images(image_task)):
            add_pending(img, "flutuante", image_task["order"] if image_task else None)
        elif image_task and not task_has_own_images(image_task):
            ref = _image_ref(img)
            if not any(_same_image(ref, x) for x in all_item_images()):
                item = _reference_text([prompt_text]) if prompt_text else {"prompt": "", "expectedAnswer": None}
                image_task["items"].append({**item, "image": ref, "fromReference": True})
        else:
            add_pending(img, "referência", image_task["order"] if image_task else None)

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
            rows = table_cells(b['table'], document)
            consumed.add(j)
            if table_is_red(rows):
                if cur is None:
                    new_task("")
                before = len(cur["items"])
                def table_note(note, task=cur):
                    task["instruction"] = (task["instruction"] + "\n" + note).strip()
                parse_table_items(rows, cur["items"].append, table_note)
                for it in cur["items"][before:]:
                    for x in [it.get("image")] + it.get("extraImages", []):
                        if x and next((i for i in b['images'] if _same_image(i, x)), {}).get("floating"):
                            it["imageFloatingInCell"] = True
                in_block = True
                last_item = cur["items"][-1] if cur["items"] else last_item
                continue
            caption = pending_caption
            td = table_to_dict(b['table'], caption)
            if td.pop('_imageDependent'):
                requires_images = True
            tables.append(td)
            for item, img in reference_row_items(rows):
                if img["floating"] and not (image_task and not task_has_own_images(image_task)):
                    add_pending(img, "flutuante", image_task["order"] if image_task else None)
                elif image_task and not task_has_own_images(image_task):
                    ref = _image_ref(img)
                    if not any(_same_image(ref, x) for x in all_item_images()):
                        image_task["items"].append({**item, "image": ref, "fromReference": True})
                else:
                    add_pending(img, "referência", image_task["order"] if image_task else None)
            pending_caption = None
            current_phrase_group = None
            in_block = False
            image_task_in_run = False
            flush_dialogue()
            continue

        text = b['text']
        images = b['images']

        if not text:
            # paragrafo so com imagem: e da frase do paragrafo logo acima
            for img in images:
                if in_block and cur is not None:
                    if img["floating"]:
                        add_pending(img, "flutuante", cur["order"])
                    elif last_item is not None and not last_item.get("image"):
                        last_item["image"] = _image_ref(img)
                    else:
                        last_item = builder.add_image_item(img)
                else:
                    # no texto de referencia, a frase de cima nem sempre e a da
                    # foto (as fotos da 2F e da 19B vem antes da legenda): vira
                    # item so com a imagem
                    reference_image(img, None)
            consumed.add(j)
            continue

        if b['is_red']:
            stripped = text.strip()
            consumed.add(j)
            tm = TAREFA_RE.match(stripped)
            # "TAREFA: praticar não mais do que 2x" e nota da licao; so vira
            # task se o resto da linha for uma ("TAREFA: The AI Tutor asks...")
            if tm and len(stripped) < 400 and not ACTOR_START_RE.match(tm.group('rest') or ''):
                flush_dialogue()
                pending_caption = None
                current_phrase_group = None
                used_tabela = used_tabela or tm.group('word').upper() == 'TABELA'
                trailing = tm.group('rest').strip()
                if trailing:
                    practice_note = trailing
                cur, builder, in_block, last_item = None, None, True, None
                for img in images:
                    add_pending(img, "flutuante" if img["floating"] else "no marcador TAREFA")
                continue
            if tm:
                text = tm.group('rest').strip()
                in_block = True
            if NO_TASK_RE.match(stripped):
                no_tasks_note = stripped
                continue

            if is_new_task(text, cur["instruction"] if cur else ""):
                flush_dialogue()
                pending_caption = None
                current_phrase_group = None
                task = new_task(text)
                for img in images:
                    if img["floating"]:
                        add_pending(img, "flutuante", task["order"])
                    else:
                        last_item = builder.add_image_item(img)
                continue

            if in_block:
                if cur is None:
                    # "TAREFA:" seguido so de perguntas, sem frase de instrucao (B1U5 24C)
                    new_task("")
                # "Yes, he is / No, he's not / Yes, she is / ..." logo abaixo da
                # instrucao (3F): as formas de resposta, nota da task
                answer_forms = (not cur["items"] and text.count(' / ') >= 2
                                and split_speaker(split_label(text)[1])[0] is None)
                if answer_forms or is_task_note(text):
                    cur["instruction"] = (cur["instruction"] + "\n" + text).strip()
                    if IMAGE_RE.search(text):
                        requires_images = True
                    # imagem logo abaixo de uma nota nao e de nenhum item anterior
                    target = last_item = None
                else:
                    target = builder.add_line(text, b['para'].text)
                    if target is not None:
                        last_item = target
                for img in images:
                    if img["floating"]:
                        add_pending(img, "flutuante", cur["order"])
                    elif target is not None and not target.get("image"):
                        target["image"] = _image_ref(img)
                    else:
                        last_item = builder.add_image_item(img)
                continue

            # vermelho depois de texto preto, sem ser task nova: material de
            # pratica (frases de exemplo, dialogos) colorido por convencao da
            # escola. Vai para referenceContent.
            for img in images:
                reference_image(img, text)
            if DIALOGUE_TURN_RE.match(text):
                if not current_dialogue and pending_caption:
                    current_dialogue.append(pending_caption)
                    pending_caption = None
                current_dialogue.append(text)
                continue

            flush_dialogue()

            if looks_like_heading(text):
                current_phrase_group = text
                phrase_group(text)
                continue

            if current_phrase_group is not None:
                phrase_group(current_phrase_group)["phrases"].append(text)
            else:
                vocabulary.append(text)
            continue

        # texto preto (referencia)
        in_block = False
        image_task_in_run = False
        last_item = None
        current_phrase_group = None
        for img in images:
            reference_image(img, text)
        consumed.add(j)
        if DIALOGUE_TURN_RE.match(text):
            if not current_dialogue and pending_caption:
                current_dialogue.append(pending_caption)
                pending_caption = None
            current_dialogue.append(text)
            continue

        flush_dialogue()

        vm = VOCAB_RE.fullmatch(text)
        is_caption_like = bool(re.match(r'^DIALOGUE\b', text, re.IGNORECASE)) or (
            vm and vm.group('def').isupper()
        )
        if vm and len(text) <= 90 and not is_caption_like:
            vocabulary.append(text)
            pending_caption = None
            continue

        if looks_like_heading(text):
            pending_caption = text
            grammar_notes.append(text)
            continue

        pending_caption = None
        grammar_notes.append(text)

    flush_dialogue()

    for t in tasks:
        finalize_items(t["items"])
        has_imgs = any(i.get("image") for i in t["items"])
        t["imageDependency"] = classify_image_dependency(t["instruction"], has_imgs)
        if t["type"] == "other" and not t["instruction"] and t["items"]:
            t["type"] = "student_answers" if any(i["prompt"].rstrip().endswith("?") for i in t["items"]) else "other"
        if EXAMPLES_RE.search(t["instruction"]):
            t["itemsAreExamples"] = True
        if has_imgs:
            requires_images = True

    lesson = {
        "code": code,
        "title": title_text,
        "skill": skill,
        "order": order,
    }
    if practice_note:
        lesson["practiceNote"] = practice_note
    if no_tasks_note:
        lesson["noTasksNote"] = no_tasks_note
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
    # Imagens sem destino claro: vao para a pasta da licao e sao pendencia.
    lesson["pendingImages"] = pending
    lesson["_titleLine"] = title_block['text']
    lesson["_usedTabela"] = used_tabela
    return lesson


def source_excerpt(blocks, start, end):
    """Trecho original da licao em texto: o vermelho vai marcado com
    [VERMELHO], tabelas viram linhas "a | b", imagens viram [IMAGEM]."""
    lines = []
    for b in blocks[start:end]:
        if b['kind'] == 'table':
            for row in b['table'].rows:
                cells = [c.text.strip().replace('\n', ' / ') for c in row.cells]
                lines.append('| ' + ' | '.join(cells) + ' |')
        elif b['text']:
            lines.append(('[VERMELHO] ' if b['is_red'] else '') + b['text'])
        if b.get('images'):
            lines.append('[IMAGEM] ' + ', '.join(i['media'] + (' (recortada)' if i['crop'] else '') for i in b['images']))
    return '\n'.join(lines)


# --- alertas (relatorio e conferencia) -----------------------------------

_CROSS_REF_RE = re.compile(
    r'mesmas\s+imagens|imagens\s+das\s+li[çc][õo]es|acima\s*\(|tabela\s+abaixo|di[áa]logo\s+anterior|'
    r'li[çc][ãa]o\s+\w+\s+sobre|previous\s+lesson|\b(?:in|from|to|similar\s+to)\s+[a-e]\)|\bin\s+a\b,|'
    r'lessons?\s+\d+\s?[A-Z]?\b|book\s+\d+\s+unit\s+\d+|\bunit\s+\d+\b',
    re.IGNORECASE,
)
_SCREEN_RE = re.compile(r'on\s+the\s+screen|na\s+tela', re.IGNORECASE)
_STUDENT_PHOTO_RE = re.compile(r'student\s+to\s+show\s+a\s+picture|cell\s+phone', re.IGNORECASE)
BROWSER_IMAGE_EXTS = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'}


def lesson_alerts(result, l):
    alerts = []
    book_n = re.search(r'\d+', result["book"] or "")
    unit_n = re.search(r'\d+', result["unit"] or "")
    tl = l.get("_titleLine", "")
    for word, n in (("Unit", unit_n), ("Book", book_n)):
        m = re.search(word + r'\s+(\d+)', tl, re.IGNORECASE)
        if m and n and m.group(1) != n.group(0):
            alerts.append(f"título “{tl.strip()}” diz {word} {m.group(1)}, mas o arquivo é {word} {n.group(0)}.")
    if l.get("_usedTabela"):
        alerts.append("marcador “TABELA” onde normalmente vem “TAREFA” — tratado como TAREFA.")
    if not l["tasks"]:
        if l.get("noTasksNote"):
            alerts.append(f"sem tasks, como a escola escreveu: “{l['noTasksNote']}”.")
        else:
            alerts.append("lição sem nenhuma instrução em vermelho (nada foi inventado).")
    for t in l["tasks"]:
        tid = f"task-{t['order']}"
        if not t["instruction"]:
            alerts.append(f"{tid}: a escola listou só os itens, sem frase de instrução.")
        if t["type"] == "other":
            alerts.append(f"{tid}: tipo não reconhecido.")
        imgs = [i for i in t["items"] if i.get("image")]
        if t["imageDependency"] != "oral" and not imgs:
            sug = [p for p in l["pendingImages"] if p.get("suggestedTask") == t["order"]]
            extra = f" ({len(sug)} pendente(s) com sugestão para ela)" if sug else ""
            alerts.append(f"{tid}: fala de imagem, mas nenhuma imagem ficou ligada a um item{extra}.")
        m = _CROSS_REF_RE.search(t["instruction"])
        if m:
            alerts.append(f"{tid}: remete a outro trecho/lição (“{m.group(0)}”).")
        if _SCREEN_RE.search(t["instruction"] + " ".join(i["prompt"] for i in t["items"])):
            alerts.append(f"{tid}: pede para mostrar algo NA TELA que não é imagem (ex.: horário digital).")
        if _STUDENT_PHOTO_RE.search(t["instruction"] + " ".join((i["expectedAnswer"] or "") for i in t["items"])):
            alerts.append(f"{tid}: pede para o ALUNO mostrar uma foto dele — o chat não recebe fotos.")
        if any(i.get("extraImages") for i in t["items"]):
            alerts.append(f"{tid}: item com mais de uma imagem na mesma célula (a principal foi escolhida; as outras ficam em extraImages).")
        if any(i.get("fromReference") for i in t["items"]):
            alerts.append(f"{tid}: imagens ligadas pelo texto de referência logo abaixo (a task não traz fotos próprias) — conferir.")
        for i in t["items"]:
            ext = (i.get("image") or {}).get("media", "").rsplit('.', 1)[-1].lower()
            if ext and ext not in BROWSER_IMAGE_EXTS:
                alerts.append(f"{tid}: imagem .{ext} (navegador não exibe; precisa converter).")
                break
    red_source = "\n".join(x for x in l.get("sourceExcerpt", "").split("\n") if x.startswith("[VERMELHO]"))
    if _SCREEN_RE.search(red_source) and not any("NA TELA" in a for a in alerts):
        alerts.append("pede para mostrar algo NA TELA que não é imagem (ex.: “Tutor (showing time on the screen)”).")
    if l["pendingImages"]:
        alerts.append(f"{len(l['pendingImages'])} imagem(ns) sem destino claro (pendência).")
    return alerts


# --- relatorio de analise (markdown) ------------------------------------

def _quote(text):
    return '\n'.join('> ' + line for line in text.split('\n'))


def _img_label(ref):
    return ref["media"].split('/')[-1] + (" (recorte)" if ref.get("crop") else "")


def write_report(result, orphan_red, path):
    lessons = result["lessons"]
    total_tasks = sum(len(l["tasks"]) for l in lessons)
    total_items = sum(len(t["items"]) for l in lessons for t in l["tasks"])
    linked = sum(1 for l in lessons for t in l["tasks"] for i in t["items"] if i.get("image"))
    pending = sum(len(l["pendingImages"]) for l in lessons)
    all_alerts = []
    out = [
        f"# Análise — {result['book']} / {result['unit']}",
        "",
        f"Arquivo: `{result['sourceFile']}` · gerado por `scripts/processar-unit.py --report` em {result['processedAt'][:10]}",
        "",
        f"**{len(lessons)} lições · {total_tasks} tasks · {total_items} itens · "
        f"{linked} imagens ligadas a itens · {pending} imagens pendentes**",
        "",
        "Legenda: o texto em citação (`>`) é o vermelho da escola, copiado literalmente.",
        "Tipo = o que o aluno faz; imagem = oral / visual (usa imagem) / image-only (pulada sem imagem).",
        "Itens: P = o que a Debbie diz/mostra · R = resposta esperada do aluno · D = réplica da Debbie (quando o aluno abre o diálogo).",
        "",
        "## Princípios gerais",
        "",
    ]
    out += [f"- {p}" for p in result["globalPrinciples"]] or ["- (o documento não traz princípios gerais)"]
    out.append("")

    for l in lessons:
        out += [f"## Lesson {l['code']} — {l.get('title') or '(sem título)'}", ""]
        out.append(f"Skill: {l.get('skill') or '—'} · ordem {l['order']}")
        out.append("")
        if l.get("practiceNote"):
            out += ["Nota da TAREFA (vermelho):", "", _quote(l["practiceNote"]), ""]
        if not l["tasks"]:
            if l.get("noTasksNote"):
                out += [f"**Sem tasks** — a escola escreveu: “{l['noTasksNote']}”", ""]
            else:
                out += ["**⚠ Sem nenhuma instrução em vermelho.** Nada foi inventado — pergunta para a escola.", ""]
        for t in l["tasks"]:
            reps = extract_repetitions(t["instruction"])
            meta = [f"tipo `{t['type']}`", f"imagem `{t['imageDependency']}`",
                    f"{len(t['items'])} itens" + (" (exemplos)" if t.get("itemsAreExamples") else "")]
            meta.append("repetições: " + ("; ".join(f"“{r}”" for r in reps) if reps else "não diz"))
            out += [f"**Task {t['order']}** — " + " · ".join(meta), ""]
            out += [_quote(t["instruction"]) if t["instruction"] else "> *(sem frase de instrução)*", ""]
            for n, i in enumerate(t["items"], 1):
                parts = []
                if i.get("label"):
                    parts.append(f"[{i['label']}]")
                if i["prompt"]:
                    parts.append("P: " + i["prompt"].replace("\n", " / "))
                if i["expectedAnswer"]:
                    parts.append("R: " + i["expectedAnswer"].replace("\n", " / "))
                if i.get("reply"):
                    parts.append("D: " + i["reply"].replace("\n", " / "))
                if i.get("image"):
                    parts.append(f"🖼 `{_img_label(i['image'])}`" + (" *(do texto de referência)*" if i.get("fromReference") else ""))
                if i.get("extraImages"):
                    parts.append("+ " + ", ".join(f"`{_img_label(x)}`" for x in i["extraImages"]))
                out.append(f"    {n}. " + " · ".join(parts))
            if t["items"]:
                out.append("")

        ref = l["referenceContent"]
        out += ["### Conteúdo de referência (preto)", ""]
        if ref["dialogues"]:
            out.append("Diálogos:")
            for d in ref["dialogues"]:
                out.append("- " + " / ".join(d))
        if ref["vocabulary"]:
            out.append("Vocabulário: " + "; ".join(ref["vocabulary"]))
        if ref["grammarNotes"]:
            out.append("Notas:")
            for n in ref["grammarNotes"]:
                out.append(f"- {n}")
        for tb in ref["tables"]:
            out.append(f"Tabela{(' — ' + tb['caption']) if tb.get('caption') else ''}:")
            for row in tb["rows"]:
                cells = [c.replace('\n', ' / ') for c in row]
                out.append("    | " + " | ".join(cells) + " |")
        for g in ref["practicePhrases"]:
            out.append(f"Frases de prática (vermelho, em inglês) — {g['group']}: " + "; ".join(g["phrases"]))
        if not any(ref.values()):
            out.append("(nenhum)")
        out.append("")

        if l["pendingImages"]:
            out += ["### Imagens pendentes (pasta da lição)", ""]
            for p in l["pendingImages"]:
                sug = f" · sugestão: task-{p['suggestedTask']}" if p.get("suggestedTask") else ""
                out.append(f"- `{_img_label(p)}` — {p['reason']}{sug}")
            out.append("")

        alerts = lesson_alerts(result, l)
        all_alerts += [f"{l['code']}: {a}" for a in alerts]

    out += ["## Alertas automáticos", ""]
    out += [f"- {a}" for a in all_alerts] or ["- (nenhum)"]
    out += ["", "## Vermelho fora de qualquer lição", ""]
    out += [f"- {t}" for t in orphan_red] or ["- (nenhum)"]
    out.append("")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('\n'.join(out), encoding='utf-8')


# --- pagina de conferencia (html) ----------------------------------------

def image_bytes(document, ref, max_side=None):
    """Bytes da imagem do .docx com o recorte aplicado. Com max_side, devolve
    uma miniatura PNG/JPEG (o que o navegador exibe, inclusive de TIFF)."""
    part = next(p for p in document.part.package.parts if str(p.partname).lstrip('/') == ref["media"])
    blob = part.blob
    crop = ref.get("crop")
    if not crop and not max_side:
        return blob, ref["media"].rsplit('.', 1)[-1].lower()
    from PIL import Image
    img = Image.open(io.BytesIO(blob))
    if crop:
        w, h = img.size
        box = (max(0, crop.get('l', 0)) * w, max(0, crop.get('t', 0)) * h,
               w - max(0, crop.get('r', 0)) * w, h - max(0, crop.get('b', 0)) * h)
        img = img.crop(tuple(int(round(v)) for v in box))
    if max_side:
        img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    if img.mode in ('RGBA', 'LA', 'P'):
        img.convert('RGBA').save(buf, 'PNG')
        return buf.getvalue(), 'png'
    img.convert('RGB').save(buf, 'JPEG', quality=82)
    return buf.getvalue(), 'jpeg'


def write_html(result, document, path):
    cache = {}

    def thumb(ref):
        key = (ref["media"], json.dumps(ref.get("crop"), sort_keys=True))
        if key not in cache:
            try:
                data, ext = image_bytes(document, ref, max_side=420)
                cache[key] = f"data:image/{ext};base64," + base64.b64encode(data).decode()
            except Exception as err:  # imagem que o Pillow nao abre
                cache[key] = None
                print(f"  aviso: nao gerei miniatura de {ref['media']}: {err}")
        return cache[key]

    def img_tag(ref, cls="ph"):
        src = thumb(ref)
        name = html.escape(_img_label(ref))
        if not src:
            return f'<div class="{cls} missing">sem miniatura<br>{name}</div>'
        return f'<figure class="{cls}"><img src="{src}" alt="{name}" loading="lazy"><figcaption>{name}</figcaption></figure>'

    e = html.escape
    lessons = result["lessons"]
    total_items = sum(len(t["items"]) for l in lessons for t in l["tasks"])
    linked = sum(1 for l in lessons for t in l["tasks"] for i in t["items"] if i.get("image"))
    pending = sum(len(l["pendingImages"]) for l in lessons)
    body = []
    toc = []
    for l in lessons:
        anchor = f"l-{l['code']}"
        n_img = sum(1 for t in l["tasks"] for i in t["items"] if i.get("image"))
        toc.append(f'<a href="#{anchor}">{e(l["code"])}<small>{n_img}🖼{" · " + str(len(l["pendingImages"])) + "⚠" if l["pendingImages"] else ""}</small></a>')
        sec = [f'<section id="{anchor}"><h2><span class="code">{e(l["code"])}</span> {e(l.get("title") or "(sem título)")}</h2>']
        alerts = lesson_alerts(result, l)
        if alerts:
            sec.append('<ul class="alerts">' + "".join(f"<li>{e(a)}</li>" for a in alerts) + "</ul>")
        if l.get("practiceNote"):
            sec.append(f'<p class="note"><b>Nota da TAREFA:</b> {e(l["practiceNote"])}</p>')
        if not l["tasks"]:
            sec.append(f'<p class="empty">{e(l.get("noTasksNote") or "Sem nenhuma instrução em vermelho.")}</p>')
        for t in l["tasks"]:
            sec.append(f'<div class="task"><div class="task-head"><b>Task {t["order"]}</b>'
                       f'<span class="tag">{e(t["type"])}</span><span class="tag">{e(t["imageDependency"])}</span>'
                       f'{"<span class=tag>exemplos</span>" if t.get("itemsAreExamples") else ""}</div>'
                       f'<blockquote>{e(t["instruction"]) if t["instruction"] else "<i>(sem frase de instrução)</i>"}</blockquote>')
            if t["items"]:
                sec.append('<ol class="items">')
                for i in t["items"]:
                    txt = []
                    if i.get("label"):
                        txt.append(f'<span class="label">{e(i["label"])}</span>')
                    if i["prompt"]:
                        txt.append(f'<div class="p"><b>Debbie</b> {e(i["prompt"])}</div>')
                    if i["expectedAnswer"]:
                        txt.append(f'<div class="a"><b>Resposta</b> {e(i["expectedAnswer"])}</div>')
                    if i.get("reply"):
                        txt.append(f'<div class="r"><b>Réplica</b> {e(i["reply"])}</div>')
                    if i.get("fromReference"):
                        txt.append('<div class="warn">ligada pelo texto de referência — conferir</div>')
                    if i.get("imageFloatingInCell"):
                        txt.append('<div class="muted">imagem flutuante dentro da célula da linha</div>')
                    pics = ""
                    if i.get("image"):
                        pics = img_tag(i["image"])
                        for x in i.get("extraImages", []):
                            pics += img_tag(x, "ph extra")
                    else:
                        pics = '<div class="ph none">sem imagem</div>'
                    sec.append(f'<li><div class="txt">{"".join(txt) or "<i>(só imagem)</i>"}</div><div class="pics">{pics}</div></li>')
                sec.append("</ol>")
            sec.append("</div>")
        if l["pendingImages"]:
            sec.append('<div class="pending"><h3>Imagens pendentes — vão para a pasta da lição</h3><div class="grid">')
            for p in l["pendingImages"]:
                sug = f" · sugestão: task-{p['suggestedTask']}" if p.get("suggestedTask") else ""
                sec.append(f'<div>{img_tag(p)}<p>{e(p["reason"])}{e(sug)}</p></div>')
            sec.append("</div></div>")
        sec.append("</section>")
        body.append("\n".join(sec))

    page = f"""<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conferência {e(result['book'] or '')} {e(result['unit'] or '')}</title>
<style>
:root {{ --bg:#f6f5f2; --card:#fff; --ink:#1d1d1b; --muted:#6b6a66; --line:#e2e0da; --red:#b3261e; --accent:#2f5d8a; --warn:#8a5a00; --warnbg:#fff4dc; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#161615; --card:#21211f; --ink:#ecebe7; --muted:#a3a29c; --line:#3a3936; --red:#ff8a80; --accent:#8fb8e3; --warn:#f3c66b; --warnbg:#3a2e12; }} }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }}
header {{ padding:20px 16px 8px; max-width:1100px; margin:auto; }}
h1 {{ margin:0 0 4px; font-size:22px; }}
.sum {{ color:var(--muted); margin:0; }}
nav {{ position:sticky; top:0; z-index:2; background:var(--bg); border-bottom:1px solid var(--line); padding:8px 16px; display:flex; gap:6px; overflow-x:auto; }}
nav a {{ flex:none; text-decoration:none; color:var(--ink); background:var(--card); border:1px solid var(--line); border-radius:6px; padding:3px 8px; font-weight:600; }}
nav small {{ font-weight:400; color:var(--muted); margin-left:5px; }}
main {{ max-width:1100px; margin:auto; padding:8px 16px 60px; }}
section {{ background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin:16px 0; scroll-margin-top:56px; }}
h2 {{ margin:0 0 10px; font-size:18px; }} .code {{ color:var(--accent); }}
.alerts {{ background:var(--warnbg); color:var(--warn); border-radius:8px; padding:8px 8px 8px 28px; margin:0 0 12px; font-size:13.5px; }}
.note, .empty {{ color:var(--muted); }}
.task {{ border-top:1px solid var(--line); padding-top:12px; margin-top:12px; }}
.task-head {{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }}
.tag {{ font-size:12px; border:1px solid var(--line); border-radius:99px; padding:0 8px; color:var(--muted); }}
blockquote {{ margin:8px 0; padding:8px 12px; border-left:3px solid var(--red); color:var(--red); white-space:pre-wrap; background:transparent; }}
ol.items {{ margin:8px 0 0; padding-left:22px; }}
ol.items li {{ display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; align-items:start; padding:8px 0; border-bottom:1px dashed var(--line); }}
.txt div {{ white-space:pre-wrap; }} .txt b {{ display:inline-block; min-width:72px; font-size:12px; color:var(--muted); font-weight:600; }}
.label {{ font-size:12px; font-weight:700; color:var(--accent); }}
.warn {{ color:var(--warn); font-size:12.5px; }} .muted {{ color:var(--muted); font-size:12.5px; }}
.pics {{ display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }}
figure.ph {{ margin:0; width:220px; }} figure.ph img {{ width:100%; height:auto; border-radius:6px; border:1px solid var(--line); background:#fff; }}
figure.extra {{ width:90px; opacity:.75; }}
figcaption {{ font-size:11px; color:var(--muted); word-break:break-all; }}
.ph.none, .ph.missing {{ width:120px; font-size:12px; color:var(--muted); border:1px dashed var(--line); border-radius:6px; padding:12px 6px; text-align:center; }}
.pending {{ margin-top:14px; border-top:1px solid var(--line); padding-top:10px; }}
.pending h3 {{ font-size:14px; margin:0 0 8px; color:var(--warn); }}
.grid {{ display:flex; gap:12px; flex-wrap:wrap; }} .grid p {{ margin:2px 0 0; font-size:12px; color:var(--muted); max-width:220px; }}
@media (max-width:640px) {{ ol.items li {{ grid-template-columns:1fr; }} .pics {{ justify-content:flex-start; }} figure.ph {{ width:100%; max-width:320px; }} }}
</style></head><body>
<header><h1>Conferência — {e(result['book'] or '')} / {e(result['unit'] or '')}</h1>
<p class="sum">{e(result['sourceFile'])} · {len(lessons)} lições · {total_items} itens · {linked} imagens ligadas · {pending} pendentes</p></header>
<nav>{''.join(toc)}</nav>
<main>{''.join(body)}</main>
</body></html>"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(page, encoding='utf-8')


# --- pipeline principal ---------------------------------------------------

def parse_book_unit_from_filename(path):
    """"book01-unit01.docx" ou "THE WAY for AI_Book 1_Unit 3_prompts.docx"."""
    m = re.search(r'book\s*0*(\d+)\D{0,3}unit\s*0*(\d+)', path.stem, re.IGNORECASE)
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
        if b['kind'] == 'para' and b['text'] and not b['is_red'] and len(b['text']) <= 120:
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
        lesson = extract_lesson(blocks, ti, end, idx + 1, consumed, document)
        lesson["sourceExcerpt"] = source_excerpt(blocks, ti, end)
        lessons.append(lesson)

    # pendencia que e a mesma foto de um item de outra licao ("USAR AS
    # MESMAS IMAGENS DO 4ABC"): diz de onde ela e
    used = {}
    for l in lessons:
        for t in l["tasks"]:
            for i in t["items"]:
                if i.get("image"):
                    used.setdefault(i["image"]["media"], f"{l['code']} task-{t['order']}")
    for l in lessons:
        for p in l["pendingImages"]:
            origin = used.get(p["media"])
            if origin and not origin.startswith(l["code"] + " "):
                p["sameAs"] = origin
                p["reason"] += f" — mesma imagem de {origin}"

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

    write_json(result, out_path)
    return result, orphan_red, document


def write_json(result, out_path):
    clean = {**result, "lessons": [{k: v for k, v in l.items() if not k.startswith('_')} for l in result["lessons"]]}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(clean, f, ensure_ascii=False, indent=2)


# --- exportacao das imagens (carga no banco) -------------------------------

# O que o navegador nao exibe vira PNG (o original continua no .docx,
# guardado no bucket source-docs).
BROWSER_EXTS = {'png': 'png', 'jpeg': 'jpg', 'jpg': 'jpg', 'gif': 'gif', 'webp': 'webp', 'svg': 'svg'}


def export_image(document, ref):
    """(bytes, extensao) da imagem como ela aparece no .docx: recorte aplicado,
    formato original quando o navegador exibe, PNG quando nao (TIFF, EMF...)."""
    part = next(p for p in document.part.package.parts if str(p.partname).lstrip('/') == ref["media"])
    ext = ref["media"].rsplit('.', 1)[-1].lower()
    crop = ref.get("crop")
    if ext in BROWSER_EXTS and (not crop or ext == 'svg'):
        return part.blob, BROWSER_EXTS[ext]
    from PIL import Image
    img = Image.open(io.BytesIO(part.blob))
    if crop:
        w, h = img.size
        box = (max(0, crop.get('l', 0)) * w, max(0, crop.get('t', 0)) * h,
               w - max(0, crop.get('r', 0)) * w, h - max(0, crop.get('b', 0)) * h)
        img = img.crop(tuple(int(round(v)) for v in box))
    buf = io.BytesIO()
    if BROWSER_EXTS.get(ext) == 'jpg':
        img.convert('RGB').save(buf, 'JPEG', quality=92)
        return buf.getvalue(), 'jpg'
    img.save(buf, 'PNG') if img.mode in ('RGB', 'RGBA', 'L', 'LA', 'P') else img.convert('RGBA').save(buf, 'PNG')
    return buf.getvalue(), 'png'


def export_images(result, document, images_dir):
    """Grava as imagens em <images_dir>/<caminho no bucket> e troca, no JSON,
    a referencia ao .docx ("image") pelo caminho no bucket lesson-images:
        <book>/<unit>/<licao>/task-<n>-item-<m>.<ext>
        (extras da mesma celula: task-<n>-item-<m>-<k>.<ext>)
        <book>/<unit>/<licao>/pendentes/imagem-<k>[-sugestao-task-<n>].<ext>
            (sem item: o /admin mostra em "Imagens sem item" para ligar)
    """
    book = f"book{int(result['book'].split()[1]):02d}"
    unit = f"unit{int(result['unit'].split()[1]):02d}"
    images_dir = Path(images_dir)

    def save(ref, stem):
        data, ext = export_image(document, ref)
        path = f"{stem}.{ext}"
        target = images_dir / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return path

    count = 0
    for l in result["lessons"]:
        folder = f"{book}/{unit}/{l['code']}"
        for t in l["tasks"]:
            for m, item in enumerate(t["items"], 1):
                stem = f"{folder}/task-{t['order']}-item-{m}"
                if item.get("image"):
                    item["imagePath"] = save(item.pop("image"), stem)
                    count += 1
                extras = item.pop("extraImages", None)
                if extras:
                    item["extraImagePaths"] = [save(x, f"{stem}-{k}") for k, x in enumerate(extras, 2)]
                    count += len(extras)
        pending = []
        for k, p in enumerate(l["pendingImages"], 1):
            hint = f"-sugestao-task-{p['suggestedTask']}" if p.get("suggestedTask") else ""
            entry = {"path": save(p, f"{folder}/pendentes/imagem-{k}{hint}"), "reason": p["reason"]}
            for key in ("suggestedTask", "sameAs"):
                if p.get(key) is not None:
                    entry[key] = p[key]
            pending.append(entry)
            count += 1
        l["pendingImages"] = pending
    return count


def print_report(result, orphan_red):
    lessons = result["lessons"]
    print(f"\n=== RELATORIO — {result['sourceFile']} ({result['book']} / {result['unit']}) ===")
    print(f"Licoes extraidas: {len(lessons)}")
    print("Codigos:", ", ".join(l["code"] for l in lessons))
    dup = sorted({l["code"] for l in lessons if [x["code"] for x in lessons].count(l["code"]) > 1})
    if dup:
        print(f"CODIGOS REPETIDOS: {', '.join(dup)}")

    total_tasks = sum(len(l["tasks"]) for l in lessons)
    total_items = sum(len(t["items"]) for l in lessons for t in l["tasks"])
    linked = sum(1 for l in lessons for t in l["tasks"] for i in t["items"] if i.get("image"))
    pending = sum(len(l["pendingImages"]) for l in lessons)
    print(f"Tasks: {total_tasks} · itens: {total_items} · imagens ligadas: {linked} · pendentes: {pending}")

    dist = {}
    for l in lessons:
        for t in l["tasks"]:
            dist[t["type"]] = dist.get(t["type"], 0) + 1
    print("Tipos: " + ", ".join(f"{k} {v}" for k, v in sorted(dist.items(), key=lambda kv: -kv[1])))

    for l in lessons:
        for a in lesson_alerts(result, l):
            print(f"  {l['code']}: {a}")

    print(f"Vermelho fora de qualquer licao ({len(orphan_red)}):")
    for t in orphan_red:
        print(f"  - {t[:120]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("docx_path")
    ap.add_argument("--out", default=None)
    ap.add_argument("--report", default=None, help="grava a analise em markdown (ex.: relatorios/analise-book01-unit01.md)")
    ap.add_argument("--html", default=None, help="grava a pagina de conferencia (frase e imagem lado a lado)")
    ap.add_argument("--images", default=None, help="grava as imagens (recortadas; TIFF vira PNG) nesta pasta e poe imagePath no JSON")
    args = ap.parse_args()

    docx_path = Path(args.docx_path)
    if args.out:
        out_path = Path(args.out)
    else:
        book, unit = parse_book_unit_from_filename(docx_path)
        base = (f"book{int(book.split()[1]):02d}-unit{int(unit.split()[1]):02d}" if book and unit else docx_path.stem)
        out_path = Path("src/app-config/curriculum") / f"{base}.json"

    result, orphan_red, document = process(docx_path, out_path)
    print(f"JSON gerado em: {out_path}")
    print_report(result, orphan_red)
    if args.report:
        write_report(result, orphan_red, Path(args.report))
        print(f"Analise gravada em: {args.report}")
    if args.html:
        write_html(result, document, Path(args.html))
        print(f"Conferencia gravada em: {args.html}")
    if args.images:
        n = export_images(result, document, args.images)
        write_json(result, out_path)
        print(f"{n} imagens gravadas em: {args.images} (JSON com imagePath)")


if __name__ == "__main__":
    sys.exit(main())
