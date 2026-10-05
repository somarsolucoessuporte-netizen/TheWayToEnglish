// Carrega um JSON de unit (gerado por processar-unit.py) no Supabase:
// books → units → lessons. NÃO cria steps — as lições entram com
// status 'pendente' e os steps são escritos depois, lição por lição.
//
// Idempotente (upsert por code): rodar de novo regrava o conteúdo das
// lições e o status 'pendente'. Não mexe em steps.
//
// Uso:
//   node scripts/seed-curriculum.cjs [src/app-config/curriculum/book01-unit01.json]
//
// Lê NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY do .env.local.

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

const root = path.resolve(__dirname, '..');
try { process.loadEnvFile(path.join(root, '.env.local')); } catch {}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('Faltam NEXT_PUBLIC_SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY no .env.local');
  process.exit(1);
}

const unitPath = path.resolve(process.argv[2] ?? path.join(root, 'src/app-config/curriculum/book01-unit01.json'));
const unit = JSON.parse(fs.readFileSync(unitPath, 'utf8'));

/** "Book 1" → 1 */
function number(label) {
  const match = String(label).match(/(\d+)/);
  if (!match) throw new Error(`Sem número em "${label}"`);
  return Number(match[1]);
}

const pad = (n) => String(n).padStart(2, '0');

async function main() {
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
  const bookNumber = number(unit.book);
  const unitNumber = number(unit.unit);

  const { data: book, error: bookError } = await supabase
    .from('books')
    .upsert({ code: `book${pad(bookNumber)}`, title: unit.book, order: bookNumber }, { onConflict: 'code' })
    .select()
    .single();
  if (bookError) throw bookError;

  const { data: unitRow, error: unitError } = await supabase
    .from('units')
    .upsert(
      {
        book_id: book.id,
        code: `unit${pad(unitNumber)}`,
        title: unit.unit,
        theme: unit.unitTheme ?? null,
        order: unitNumber,
        global_principles: unit.globalPrinciples ?? [],
      },
      { onConflict: 'book_id,code' }
    )
    .select()
    .single();
  if (unitError) throw unitError;

  const lessons = unit.lessons.map((l) => ({
    unit_id: unitRow.id,
    code: l.code,
    title: l.title,
    skill: l.skill,
    order: l.order,
    status: 'pendente',
    reference_content: l.referenceContent,
    practice_note: l.practiceNote ?? null,
    legacy_tasks: l.tasks,
    requires_images: l.requiresImages,
    image_note: l.imageNote ?? null,
  }));
  const { data: saved, error: lessonsError } = await supabase
    .from('lessons')
    .upsert(lessons, { onConflict: 'unit_id,code' })
    .select('code, status');
  if (lessonsError) throw lessonsError;

  console.log(`${book.code}/${unitRow.code}: ${saved.length} lições gravadas`);
  console.log(saved.map((l) => `${l.code} (${l.status})`).join(', '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
