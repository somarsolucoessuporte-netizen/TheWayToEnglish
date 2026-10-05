-- Campos da lição corrigidos à mão no /admin. O upload de um novo .docx
-- não sobrescreve nenhum campo listado aqui (o mesmo papel que
-- steps.edited_manually tem para os steps, só que por campo).
alter table lessons add column edited_fields text[] not null default '{}';
