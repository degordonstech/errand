-- MyPaddy database schema.
-- Run in the Supabase SQL editor. Safe to re-run.
-- Only the server touches these tables, using the service_role key. RLS is on with no
-- policies, so the anon and authenticated roles get nothing even if a key leaks.

create extension if not exists pgcrypto;

create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  chat_id       text not null unique,
  name          text,
  business_name text,
  -- Set during onboarding.
  preferred_name  text,
  types           text[] not null default '{}',
  features        text[] not null default '{}',
  brief_time      text,
  onboarding_step text,
  onboarded_at    timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists public.memory (
  user_id    uuid not null references public.users(id) on delete cascade,
  key        text not null,
  value      text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table if not exists public.messages (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.users(id) on delete cascade,
  direction     text not null check (direction in ('in', 'out')),
  kind          text not null check (kind in ('text', 'voice', 'image', 'video', 'doc', 'other')),
  text          text,
  message_ref   text,
  created_at    timestamptz not null default now()
);
create index if not exists messages_user_created_idx on public.messages (user_id, created_at desc);
create index if not exists messages_user_direction_created_idx on public.messages (user_id, direction, created_at desc);

create table if not exists public.pending_actions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  tool       text not null,
  args       jsonb not null,
  summary    text not null,
  status     text not null default 'waiting' check (status in ('waiting', 'approved', 'declined', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists pending_actions_user_status_idx on public.pending_actions (user_id, status);

create table if not exists public.action_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.users(id) on delete cascade,
  tool       text not null,
  args       jsonb,
  result     jsonb,
  status     text not null check (status in ('asked', 'approved', 'declined', 'expired', 'done', 'failed')),
  approved   boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists action_log_user_created_idx on public.action_log (user_id, created_at desc);

create table if not exists public.invoices (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users(id) on delete cascade,
  number         text not null,
  customer_name  text not null,
  customer_email text,
  items          jsonb not null,
  total          numeric(14, 2) not null check (total >= 0),
  currency       text not null default 'NGN',
  status         text not null default 'unpaid' check (status in ('unpaid', 'paid')),
  due_date       date,
  sent_at        timestamptz,
  reminded_at    timestamptz,
  paid_at        timestamptz,
  created_at     timestamptz not null default now(),
  unique (user_id, number)
);
create index if not exists invoices_status_idx on public.invoices (status, sent_at);

create table if not exists public.product_checks (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.users(id) on delete cascade,
  product_name text,
  nafdac_no    text,
  verdict      text not null,
  details      jsonb,
  where_bought text,
  created_at   timestamptz not null default now()
);

create table if not exists public.nafdac_cache (
  nafdac_no     text primary key,
  register_data jsonb not null,
  fetched_at    timestamptz not null default now()
);

create table if not exists public.processed_messages (
  message_ref   text primary key,
  created_at    timestamptz not null default now()
);

create table if not exists public.reminders (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  text         text not null,
  due_at       timestamptz not null,
  -- null for a one-off. Otherwise {"every": "day" | "week" | "month" | "year", "interval": n, "weekdays": [1..7], "until": "YYYY-MM-DD"}.
  repeat       jsonb,
  -- Where it came from: user, casual (picked up from conversation), snooze.
  source       text not null default 'user',
  status       text not null default 'active' check (status in ('active', 'sent', 'done', 'cancelled')),
  last_sent_at timestamptz,
  -- Set when MyPaddy asked whether a task reminder was done.
  followed_up_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists reminders_followup_idx on public.reminders (status, last_sent_at) where followed_up_at is null;
create index if not exists reminders_due_idx on public.reminders (status, due_at);
create index if not exists reminders_user_idx on public.reminders (user_id, status);

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

-- Lock down: RLS on, no policies. service_role bypasses RLS.
do $$
declare t text;
begin
  foreach t in array array['users', 'memory', 'messages', 'pending_actions', 'action_log',
                           'invoices', 'product_checks', 'nafdac_cache', 'processed_messages', 'reminders',
                           'briefs_sent', 'documents', 'people', 'lists', 'notes']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

grant usage, select on all sequences in schema public to service_role;
