import type { z } from "zod";
import type { User } from "../db/supabase.js";

export interface ToolContext {
  user: User;
  /** Set when running an approved action; used as an idempotency key for outside services. */
  actionId?: string;
}

export interface ToolResult {
  /** Shown to the user when the tool ran after approval; fed back to the model otherwise. */
  message: string;
  data?: unknown;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /**
   * Sensitive tools act on the user's behalf outside this chat (email, invoices).
   * The agent never runs them. They go through the safety gate and run only after YES.
   */
  sensitive: boolean;
  /** Plain description of exactly what will happen, shown when asking for approval. */
  summarize?(args: z.infer<S>, ctx: ToolContext): string;
  run(args: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}
