-- Corrigir unique de lessons.code
alter table lessons drop constraint lessons_code_key;
alter table lessons add constraint lessons_unit_code_unique 
  unique(unit_id, code);

-- Campos que faltam para paridade com o JSON
alter table units add column global_principles jsonb;
alter table lessons add column legacy_tasks jsonb;
alter table lessons add column requires_images boolean not null default false;
alter table lessons add column image_note text;
