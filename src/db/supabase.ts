import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import { fetchRetry } from "../net.js";
import type { MessageKind } from "../whatsapp/types.js";

export const db = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input, init) => fetchRetry(input instanceof Request ? input.url : input, init) },
});

export interface User {
  id: string;
  wa_id: string;
  name: string | null;
  business_name: string | null;
}

/** Inserts the message id; returns false if it was already there (a WhatsApp retry). */
export async function claimMessage(waMessageId: string): Promise<boolean> {
  const { error } = await db.from("processed_messages").insert({ wa_message_id: waMessageId });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(`claimMessage: ${error.message}`);
}

export async function getOrCreateUser(waId: string, name?: string): Promise<User> {
  const { data, error } = await db
    .from("users")
    .upsert({ wa_id: waId }, { onConflict: "wa_id", ignoreDuplicates: false })
    .select("id, wa_id, name, business_name")
    .single();
  if (error) throw new Error(`getOrCreateUser: ${error.message}`);
  // WhatsApp profile names change; keep the latest.
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
  waMessageId?: string,
): Promise<void> {
  const { error } = await db
    .from("messages")
    .insert({ user_id: userId, direction, kind, text: text ?? null, wa_message_id: waMessageId ?? null });
  if (error) throw new Error(`saveMessage: ${error.message}`);
}

export async function getUserById(id: string): Promise<User> {
  const { data, error } = await db.from("users").select("id, wa_id, name, business_name").eq("id", id).single();
  if (error) throw new Error(`getUserById: ${error.message}`);
  return data as User;
}

export interface StoredMessage {
  direction: "in" | "out";
  text: string | null;
}

/** Most recent messages, oldest first, for conversation history. */
export async function recentMessages(userId: string, limit: number, excludeWaMessageId?: string): Promise<StoredMessage[]> {
  const q = db.from("messages").select("direction, text, wa_message_id").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit + 1);
  const { data, error } = await q;
  if (error) throw new Error(`recentMessages: ${error.message}`);
  return (data ?? [])
    .filter((m) => !excludeWaMessageId || m.wa_message_id !== excludeWaMessageId)
    .slice(0, limit)
    .reverse()
    .map((m) => ({ direction: m.direction, text: m.text }));
}
