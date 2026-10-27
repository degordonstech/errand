import { db } from "../db/supabase.js";
import { logger } from "../log.js";

export type ActionStatus = "asked" | "approved" | "declined" | "expired" | "done" | "failed";

export interface ActionLogEntry {
  userId: string;
  tool: string;
  args?: unknown;
  result?: unknown;
  status: ActionStatus;
  approved?: boolean;
}

export async function logAction(entry: ActionLogEntry): Promise<void> {
  const { error } = await db.from("action_log").insert({
    user_id: entry.userId,
    tool: entry.tool,
    args: entry.args ?? null,
    result: entry.result ?? null,
    status: entry.status,
    approved: entry.approved ?? false,
  });
  // The log must never break the action it records.
  if (error) logger.error({ error: error.message, tool: entry.tool }, "action log write failed");
}
