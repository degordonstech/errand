import { z } from "zod";
import type OpenAI from "openai";
import { sendEmailTool } from "./email.js";
import { forget, remember } from "./memory.js";
import type { Tool } from "./types.js";

export const tools: Tool<any>[] = [remember, forget, sendEmailTool];

const byName = new Map(tools.map((t) => [t.name, t]));

export function getTool(name: string): Tool<any> | undefined {
  return byName.get(name);
}

/** Tools that send email count toward the per-user daily cap. */
export const EMAIL_TOOLS = new Set(["send_email", "send_invoice", "send_payment_reminder"]);

export function toModelTools(list: Tool<any>[] = tools): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return list.map((t) => {
    const { $schema: _ignored, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return { type: "function", function: { name: t.name, description: t.description, parameters } };
  });
}
