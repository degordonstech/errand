-- Follow-ups on task reminders. Run once in the Supabase SQL editor. Safe to re-run.
alter table public.reminders add column if not exists followed_up_at timestamptz;
create index if not exists reminders_followup_idx on public.reminders (status, last_sent_at) where followed_up_at is null;
