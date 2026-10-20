// Carrega o material da escola (os .docx de material_do_curso/originais/
// bookXX/) no Supabase e no JSON de reserva do app:
//
//   1. processar-unit.py lê cada .docx (vermelho = tasks/itens, preto =
//      conteúdo de referência) e exporta as imagens já recortadas
//      (TIFF vira PNG; o original fica no .docx);
//   2. aplica src/app-config/curriculum/ajustes-escola.json (marcações
//      "verificar com a escola", task desativada) — nunca corrige o texto;
//   3. grava books → units → lessons com as mesmas regras do upload do
//      /admin (lib/admin/mergeLessons.ts): lição nova entra 'pendente',
//      status de lição existente nunca muda, campo editado à mão
//      (edited_fields) nunca é sobrescrito, nada é apagado;
//   4. sobe as imagens para lesson-images/<book>/<unit>/<lição>/
//      task-<n>-item-<m>.<ext> (sem item claro: .../pendentes/) e o .docx
//      original para o bucket privado source-docs;
//   5. escreve src/app-config/curriculum/<book>-<unit>.json (a reserva do
//      app quando o Supabase cai), igual ao que foi gravado.
//
// Units sem princípios gerais próprios herdam os do Book 1 / Unit 1,
// marcados como herdados ({ inheritedFrom, principles }) até a escola
// responder; princípios editados no /admin (lista simples) são mantidos.
//
// Uso:
//   node scripts/carregar-material.cjs            (todos os .docx)
//   node scripts/carregar-material.cjs --dry-run  (só mostra o que faria)
//   node scripts/carregar-material.cjs <arquivo.docx> ...
//
// Lê NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY do .env.local.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { createClient } = require('@supabase/supabase-js');

const root = path.resolve(__dirname, '..');
try { process.loadEnvFile(path.join(root, '.env.local')); } catch {}

const LESSON_IMAGES_BUCKET = 'lesson-images';
const SOURCE_DOCS_BUCKET = 'source-docs';
const CONTENT_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

function loadTs(filename) {
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(require, module, module.exports);
  return module.exports;
}

const { planLessonMerge, applySchoolAdjustments, docxLessonValues } = loadTs(path.join(root, 'src/lib/admin/mergeLessons.ts'));
const adjustments = JSON.parse(fs.readFileSync(path.join(root, 'src/app-config/curriculum/ajustes-escola.json'), 'utf8'));

const pad = (n) => String(n).padStart(2, '0');
const number = (label) => Number(String(label).match(/(\d+)/)?.[1]);

function findDocx() {
  const base = path.join(root, 'material_do_curso/originais');
  return fs.readdirSync(base)
    .filter((d) => /^book\d+$/.test(d))
    .flatMap((d) => fs.readdirSync(path.join(base, d)).filter((f) => f.toLowerCase().endsWith('.docx')).map((f) => path.join(base, d, f)));
}

/** processar-unit.py com as imagens exportadas para `dir/imgs`. */
function processDocx(docxPath, dir) {
  const jsonPath = path.join(dir, 'unit.json');
  execFileSync(process.env.PYTHON_BIN || 'python', [
    path.join(root, 'scripts/processar-unit.py'), docxPath, '--out', jsonPath, '--images', path.join(dir, 'imgs'),
  ], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'ignore', 'inherit'] });
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

function listFiles(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]
  );
}

/** O JSON de reserva do app: a unit como o banco a recebe (mesma
 * practice_note, mesmas tasks), sem o que só o /admin usa. */
function bundledUnit(unit) {
  const { processedAt, ...rest } = unit;
  return {
    ...rest,
    lessons: unit.lessons.map((l) => {
      const values = docxLessonValues(l);
      const { sourceExcerpt, pendingImages, noTasksNote, practiceNote, ...lesson } = l;
      return { ...lesson, ...(values.practice_note != null && { practiceNote: values.practice_note }) };
    }),
  };
}

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const files = args.filter((a) => !a.startsWith('--')).map((f) => path.resolve(f));
  const docxFiles = files.length > 0 ? files : findDocx();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error('Faltam NEXT_PUBLIC_SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY no .env.local');
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
  const must = ({ data, error }, what) => {
    if (error) throw new Error(`${what}: ${error.message}`);
    return data;
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twte-carga-'));
  try {
    // Book 1 / Unit 1 primeiro: as outras units herdam os princípios dela.
    const units = docxFiles.map((docxPath, i) => {
      const dir = path.join(tmp, String(i));
      const unit = processDocx(docxPath, dir);
      if (!unit.book || !unit.unit) throw new Error(`Book/unit não reconhecidos no nome do arquivo: ${docxPath}`);
      return { docxPath, dir, unit, bookCode: `book${pad(number(unit.book))}`, unitCode: `unit${pad(number(unit.unit))}` };
    }).sort((a, b) => a.bookCode.localeCompare(b.bookCode) || a.unitCode.localeCompare(b.unitCode));

    if (!dryRun && !must(await supabase.storage.listBuckets(), 'buckets').some((b) => b.id === SOURCE_DOCS_BUCKET)) {
      must(await supabase.storage.createBucket(SOURCE_DOCS_BUCKET, { public: false }), `criar bucket ${SOURCE_DOCS_BUCKET}`);
      console.log(`bucket ${SOURCE_DOCS_BUCKET} criado (privado)`);
    }

    let principlesSource;
    for (const { docxPath, dir, unit, bookCode, unitCode } of units) {
      const key = `${bookCode}/${unitCode}`;
      const warnings = applySchoolAdjustments(unit.lessons, adjustments[key]);
      const images = listFiles(path.join(dir, 'imgs'));
      const own = unit.globalPrinciples ?? [];
      if (own.length > 0 && !principlesSource) principlesSource = { from: `${unit.book} / ${unit.unit}`, principles: own };
      console.log(`\n== ${unit.book} / ${unit.unit} (${path.basename(docxPath)}): ${unit.lessons.length} lições, ${images.length} imagens`);
      for (const w of warnings) console.log(`  AVISO ajustes-escola.json: ${w}`);

      fs.writeFileSync(path.join(root, `src/app-config/curriculum/${bookCode}-${unitCode}.json`), JSON.stringify(bundledUnit(unit), null, 2) + '\n');
      if (dryRun) continue;

      const book = must(await supabase.from('books')
        .upsert({ code: bookCode, title: unit.book, order: number(unit.book) }, { onConflict: 'code' })
        .select('id').single(), 'book');
      const unitRow = must(await supabase.from('units')
        .upsert({ book_id: book.id, code: unitCode, title: unit.unit, theme: unit.unitTheme ?? null, order: number(unit.unit) }, { onConflict: 'book_id,code' })
        .select('id, global_principles').single(), 'unit');

      // Princípios: os do .docx; sem eles, os herdados — a não ser que
      // alguém já os tenha editado no /admin (lista simples, não vazia).
      const current = unitRow.global_principles;
      const editedByHand = Array.isArray(current) && current.length > 0;
      let principles;
      if (own.length > 0) principles = own;
      else if (!editedByHand && principlesSource) principles = { inheritedFrom: principlesSource.from, principles: principlesSource.principles };
      if (principles !== undefined) {
        must(await supabase.from('units').update({ global_principles: principles }).eq('id', unitRow.id), 'princípios');
      }
      console.log(`  princípios: ${own.length ? 'do próprio .docx' : editedByHand ? 'mantidos (editados no /admin)' : `herdados de ${principlesSource?.from}`}`);

      const existing = must(await supabase.from('lessons').select('id, code, edited_fields, legacy_tasks').eq('unit_id', unitRow.id), 'lições');
      const plan = planLessonMerge(existing, unit.lessons);

      // As imagens sobem antes das lições que apontam para elas. As dos
      // itens de uma lição com tasks editadas à mão ficam como estão
      // (podem ter sido trocadas no /admin); as pendentes sobem sempre.
      const protectedLessons = new Set(plan.updates.filter((u) => u.protectedFields.includes('legacy_tasks')).map((u) => u.code));
      const toUpload = images.filter((p) => p.includes('/pendentes/') || !protectedLessons.has(p.split('/')[2]));
      await inBatches(toUpload, 6, async (p) => {
        const ext = p.split('.').pop().toLowerCase();
        must(await supabase.storage.from(LESSON_IMAGES_BUCKET).upload(p, fs.readFileSync(path.join(dir, 'imgs', p)), {
          contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
          upsert: true,
        }), `imagem ${p}`);
      });
      console.log(`  imagens: ${toUpload.length} enviadas${images.length > toUpload.length ? `, ${images.length - toUpload.length} mantidas (tasks editadas à mão)` : ''}`);

      if (plan.inserts.length > 0) {
        must(await supabase.from('lessons').insert(plan.inserts.map((l) => ({ ...l, unit_id: unitRow.id }))), 'inserir lições');
      }
      for (const update of plan.updates) {
        must(await supabase.from('lessons').update(update.values).eq('id', update.id), `atualizar ${update.code}`);
      }
      console.log(`  lições: ${plan.inserts.length} novas (pendente), ${plan.updates.length} atualizadas`);
      for (const u of plan.updates.filter((u) => u.protectedFields.length)) console.log(`  ${u.code}: mantidos (editados à mão) — ${u.protectedFields.join(', ')}`);
      if (plan.missingFromDocx.length) console.log(`  no banco mas não no .docx (não mexi): ${plan.missingFromDocx.join(', ')}`);

      const docName = path.basename(docxPath).normalize('NFD').replace(/[^\w.-]+/g, '_');
      must(await supabase.storage.from(SOURCE_DOCS_BUCKET).upload(`${key}/${docName}`, fs.readFileSync(docxPath), {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        upsert: true,
      }), 'docx original');
      console.log(`  original: ${SOURCE_DOCS_BUCKET}/${key}/${docName}`);
    }
    if (dryRun) console.log('\n--dry-run: nada foi gravado no banco (só os JSON de reserva)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
