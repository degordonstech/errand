import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import { fetchRetry } from "../net.js";
import type { MessageKind } from "../telegram/types.js";

export const db = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input, init) => fetchRetry(input instanceof Request ? input.url : input, init) },
});

export interface User {
  id: string;
  chat_id: string;
  name: string | null;
  business_name: string | null;
}

/** Inserts the message id; returns false if it was already there (a Telegram retry). */
export async function claimMessage(messageRef: string): Promise<boolean> {
  const { error } = await db.from("processed_messages").insert({ message_ref: messageRef });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(`claimMessage: ${error.message}`);
}

export async function getOrCreateUser(chatId: string, name?: string): Promise<User> {
  const { data, error } = await db
    .from("users")
    .upsert({ chat_id: chatId }, { onConflict: "chat_id", ignoreDuplicates: false })
    .select("id, chat_id, name, business_name")
    .single();
  if (error) throw new Error(`getOrCreateUser: ${error.message}`);
  // Telegram names change; keep the latest.
  if (name && name !== data.name) {
    await db.from("users").update({ name }).eq("id", data.id);
    data.name = name;
  }
  return data as User;
}

export async function saveMessage(
  userId: string,
  direction: "in" | "out",
  kind: MessageKind,
  text: string | undefined,
  messageRef?: string,
): Promise<void> {
  const { error } = await db
    .from("messages")
    .insert({ user_id: userId, direction, kind, text: text ?? null, message_ref: messageRef ?? null });
  if (error) throw new Error(`saveMessage: ${error.message}`);
}

export async function getUserById(id: string): Promise<User> {
  const { data, error } = await db.from("users").select("id, chat_id, name, business_name").eq("id", id).single();
  if (error) throw new Error(`getUserById: ${error.message}`);
  return data as User;
}

export interface StoredMessage {
  direction: "in" | "out";
  text: string | null;
}

/** Most recent messages, oldest first, for conversation history. */
export async function recentMessages(userId: string, limit: number, excludeRef?: string): Promise<StoredMessage[]> {
  const q = db.from("messages").select("direction, text, message_ref").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit + 1);
  const { data, error } = await q;
  if (error) throw new Error(`recentMessages: ${error.message}`);
  return (data ?? [])
    .filter((m) => !excludeRef || m.message_ref !== excludeRef)
    .slice(0, limit)
    .reverse()
    .map((m) => ({ direction: m.direction, text: m.text }));
}

/** How many messages the user has sent since a moment, for the daily limit. */
export async function countInboundSince(userId: string, since: Date): Promise<number> {
  const { count, error } = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("direction", "in")
    .gte("created_at", since.toISOString());
  if (error) throw new Error(`countInboundSince: ${error.message}`);
  return count ?? 0;
}
