-- MyPaddy moves from WhatsApp to Telegram. Run once in the Supabase SQL editor.
-- Existing rows are kept; their ids are now read as chat ids and message references.

alter table public.users rename column wa_id to chat_id;
alter table public.messages rename column wa_message_id to message_ref;
alter table public.processed_messages rename column wa_message_id to message_ref;

-- The daily message limit counts a user's inbound messages since the start of the day.
create index if not exists messages_user_direction_created_idx on public.messages (user_id, direction, created_at desc);
