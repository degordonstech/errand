import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import type { MessageKind } from "../whatsapp/types.js";

export const db = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
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
  if (name && !data.name) {
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
