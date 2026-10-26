-- Errand database schema.
-- Run in the Supabase SQL editor. Safe to re-run.
-- Only the server touches these tables, using the service_role key. RLS is on with no
-- policies, so the anon and authenticated roles get nothing even if a key leaks.

create extension if not exists pgcrypto;

create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  wa_id         text not null unique,
  name          text,
  business_name text,
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
  wa_message_id text,
  created_at    timestamptz not null default now()
);
create index if not exists messages_user_created_idx on public.messages (user_id, created_at desc);

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
  wa_message_id text primary key,
  created_at    timestamptz not null default now()
);

-- Lock down: RLS on, no policies. service_role bypasses RLS.
do $$
declare t text;
begin
  foreach t in array array['users', 'memory', 'messages', 'pending_actions', 'action_log',
                           'invoices', 'product_checks', 'nafdac_cache', 'processed_messages']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

grant usage, select on all sequences in schema public to service_role;
