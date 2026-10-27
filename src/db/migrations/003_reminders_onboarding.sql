-- Reminders and onboarding. Run once in the Supabase SQL editor. Safe to re-run.

-- What the user told MyPaddy during onboarding.
alter table public.users
  add column if not exists preferred_name  text,
  add column if not exists types           text[] not null default '{}',
  add column if not exists features        text[] not null default '{}',
  add column if not exists brief_time      text,
  add column if not exists onboarding_step text,
  add column if not exists onboarded_at    timestamptz;

create table if not exists public.reminders (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  text         text not null,
  due_at       timestamptz not null,
  -- null for a one-off. Otherwise {"every": "day" | "week" | "month", "interval": n, "weekdays": [1..7], "until": "YYYY-MM-DD"}.
  repeat       jsonb,
  -- Where it came from: user, casual (picked up from conversation), snooze.
  source       text not null default 'user',
  status       text not null default 'active' check (status in ('active', 'sent', 'done', 'cancelled')),
  last_sent_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists reminders_due_idx on public.reminders (status, due_at);
create index if not exists reminders_user_idx on public.reminders (user_id, status);

alter table public.reminders enable row level security;
revoke all on table public.reminders from anon, authenticated;
grant select, insert, update, delete on table public.reminders to service_role;
