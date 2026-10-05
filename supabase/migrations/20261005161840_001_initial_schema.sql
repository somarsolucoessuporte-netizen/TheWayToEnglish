-- Enums
create type lesson_status as enum ('ativo', 'pendente', 'desativado');
create type step_mechanic as enum (
  'repeat_after_me',
  'student_reads_list',
  'ia_asks_student_answers',
  'student_leads',
  'ia_leads_dialogue',
  'explain_rule',
  'review_random',
  'identify_image'
);
create type session_status as enum ('em_andamento', 'concluida', 'abandonada');
create type event_kind as enum (
  'speak', 'listen', 'evaluate', 'advance', 'nudge', 'pause', 'finish'
);
create type attempt_result as enum ('correct', 'incorrect', 'unclear');

-- Tabelas
create table books (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  "order" integer not null
);

create table units (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references books(id),
  code text not null,
  title text,
  theme text,
  "order" integer not null,
  unique(book_id, code)
);

create table lessons (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references units(id),
  code text not null unique,
  title text,
  skill text,
  "order" integer not null,
  status lesson_status not null default 'ativo',
  reference_content jsonb,
  practice_note text,
  source_excerpt text
);

create table steps (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lessons(id),
  "order" integer not null,
  mechanic step_mechanic not null,
  prompt_text text,
  items jsonb,
  repeats integer,
  item_order text,
  max_attempts integer,
  expected_answer text,
  image_path text,
  source_excerpt text,
  edited_manually boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  student_ref text,
  lesson_id uuid not null references lessons(id),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  score_correct integer,
  score_total integer,
  status session_status not null default 'em_andamento'
);

create table session_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id),
  step_id uuid references steps(id),
  at timestamptz not null default now(),
  kind event_kind not null,
  spoken_text text,
  transcript text,
  attempt_result attempt_result,
  duration_ms integer
);

-- RLS
alter table books enable row level security;
alter table units enable row level security;
alter table lessons enable row level security;
alter table steps enable row level security;
alter table sessions enable row level security;
alter table session_events enable row level security;

-- Storage
insert into storage.buckets (id, name, public)
values ('lesson-images', 'lesson-images', false);
