import { z } from "zod";
import { db } from "../db/supabase.js";
import { defineTool } from "./types.js";

export async function loadMemory(userId: string): Promise<Record<string, string>> {
  const { data, error } = await db.from("memory").select("key, value").eq("user_id", userId).order("key");
  if (error) throw new Error(`loadMemory: ${error.message}`);
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}

const normaliseKey = (key: string) =>
  key
    .trim()
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

export const remember = defineTool({
  name: "remember",
  description:
    "Save a fact the user wants kept for later, such as their business name, address, bank details for invoices, or a contact's email. " +
    "Use short snake_case keys like business_name, business_address, contact_chidi_email.",
  sensitive: false,
  schema: z.object({
    key: z.string().min(1).max(60),
    value: z.string().min(1).max(500),
  }),
  async run({ key, value }, { user }) {
    const k = normaliseKey(key);
    const { error } = await db
      .from("memory")
      .upsert({ user_id: user.id, key: k, value: value.trim(), updated_at: new Date().toISOString() }, { onConflict: "user_id,key" });
    if (error) throw new Error(`remember: ${error.message}`);
    if (k === "business_name") await db.from("users").update({ business_name: value.trim() }).eq("id", user.id);
    return { message: `Saved ${k}.` };
  },
});

export const forget = defineTool({
  name: "forget",
  description: "Delete a saved fact when the user asks you to forget it or says it is wrong.",
  sensitive: false,
  schema: z.object({ key: z.string().min(1).max(60) }),
  async run({ key }, { user }) {
    const k = normaliseKey(key);
    const { error, count } = await db.from("memory").delete({ count: "exact" }).eq("user_id", user.id).eq("key", k);
    if (error) throw new Error(`forget: ${error.message}`);
    return { message: count ? `Forgot ${k}.` : `Nothing was saved under ${k}.` };
  },
});
