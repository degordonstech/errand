import type { z } from "zod";
import type { User } from "../db/supabase.js";

/** A file the user sent in this turn, which a tool may keep. */
export interface TurnFile {
  kind: "photo" | "document" | "video" | "voice";
  fileId: string;
  mimeType: string;
  filename?: string;
}

export interface ToolContext {
  user: User;
  /** Files attached to the current message, or held from the one just before it. */
  files?: TurnFile[];
  /** Set when running an approved action; used as an idempotency key for outside services. */
  actionId?: string;
}

export interface ToolResult {
  /** Shown to the user when the tool ran after approval; fed back to the model otherwise. */
  message: string;
  data?: unknown;
  /** Text the user must see this turn, verbatim, whatever the model writes (for example a document explanation). */
  showUser?: string;
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
  /**
   * Plain description of exactly what will happen, shown when asking for approval.
   * Throw to refuse the request (for example, no email address on file); the message goes back to the model.
   */
  summarize?(args: z.infer<S>, ctx: ToolContext): string | Promise<string>;
  run(args: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}
