-- Briefs, documents, people, lists and notes. Run once in the Supabase SQL editor. Safe to re-run.

-- One row per brief sent, so a brief goes out at most once per user per day (or week).
create table if not exists public.briefs_sent (
  user_id uuid not null references public.users(id) on delete cascade,
  kind    text not null check (kind in ('morning', 'evening', 'weekly')),
  day     date not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, kind, day)
);

-- Files the user asked MyPaddy to keep. Telegram keeps the bytes; a bot can resend a file by its id.
create table if not exists public.documents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  name        text not null,
  description text,
  kind        text not null check (kind in ('photo', 'document', 'video', 'voice')),
  file_id     text not null,
  mime_type   text,
  created_at  timestamptz not null default now()
);
create index if not exists documents_user_idx on public.documents (user_id, created_at desc);

create table if not exists public.people (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  name       text not null,
  relation   text,
  phone      text,
  email      text,
  -- MM-DD, or YYYY-MM-DD when the year is known.
  birthday   text,
  notes      text,
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.lists (
  user_id    uuid not null references public.users(id) on delete cascade,
  name       text not null,
  items      text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, name)
);

create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  title      text not null,
  body       text not null,
  topic      text,
  created_at timestamptz not null default now()
);
create index if not exists notes_user_idx on public.notes (user_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['briefs_sent', 'documents', 'people', 'lists', 'notes']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;
