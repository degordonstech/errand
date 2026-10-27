import { db } from "../db/supabase.js";
import { logAction } from "../tools/log.js";
import type { GateStore, PendingAction } from "./gate.js";

const toAction = (r: any): PendingAction => ({
  id: r.id,
  userId: r.user_id,
  tool: r.tool,
  args: r.args,
  summary: r.summary,
  status: r.status,
  expiresAt: new Date(r.expires_at),
});

export const supabaseGateStore: GateStore = {
  async expireWaiting(userId) {
    const { error } = await db.from("pending_actions").update({ status: "expired" }).eq("user_id", userId).eq("status", "waiting");
    if (error) throw new Error(`expireWaiting: ${error.message}`);
  },

  async createPending(p) {
    const { data, error } = await db
      .from("pending_actions")
      .insert({ user_id: p.userId, tool: p.tool, args: p.args, summary: p.summary, expires_at: p.expiresAt.toISOString() })
      .select()
      .single();
    if (error) throw new Error(`createPending: ${error.message}`);
    return toAction(data);
  },

  async latestWaiting(userId) {
    const { data, error } = await db
      .from("pending_actions")
      .select()
      .eq("user_id", userId)
      .eq("status", "waiting")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`latestWaiting: ${error.message}`);
    return data ? toAction(data) : null;
  },

  async settle(id, to) {
    // The status filter makes this a compare-and-set: only one caller can move it out of "waiting".
    const { data, error } = await db.from("pending_actions").update({ status: to }).eq("id", id).eq("status", "waiting").select("id");
    if (error) throw new Error(`settle: ${error.message}`);
    return (data ?? []).length === 1;
  },

  async countSentSince(userId, tools, since) {
    const { count, error } = await db
      .from("action_log")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "done")
      .in("tool", [...tools])
      .gte("created_at", since.toISOString());
    if (error) throw new Error(`countSentSince: ${error.message}`);
    return count ?? 0;
  },

  log: logAction,
};
