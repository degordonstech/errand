import type OpenAI from "openai";
import { config } from "../config.js";
import { logger } from "../log.js";
import type { SafetyGate } from "../safety/gate.js";
import { cleanReply } from "../text.js";
import { getTool, toModelTools, tools as allTools } from "../tools/index.js";
import type { Tool, ToolContext } from "../tools/types.js";
import { meta, retryModelNotFound, SPARK_MAX_TOKENS } from "./client.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;
type AssistantMessage = OpenAI.Chat.Completions.ChatCompletionMessage;

export const MAX_STEPS = 6;

export type Complete = (messages: ChatMessage[], tools: OpenAI.Chat.Completions.ChatCompletionTool[]) => Promise<AssistantMessage>;

const sparkComplete: Complete = async (messages, tools) => {
  const res = await retryModelNotFound(() =>
    meta.chat.completions.create({
      model: config.MUSE_SPARK_MODEL,
      max_tokens: SPARK_MAX_TOKENS,
      messages,
      tools,
    }),
  );
  const choice = res.choices[0];
  if (!choice.message.content && !choice.message.tool_calls?.length) {
    logger.warn({ finish: choice.finish_reason, usage: res.usage }, "model returned an empty message");
  }
  return choice.message;
};

export interface AgentInput {
  ctx: ToolContext;
  system: string;
  history: ChatMessage[];
  /** The new message: text, plus any image parts. */
  content: string | ContentPart[];
}

export interface AgentDeps {
  gate: Pick<SafetyGate, "request">;
  complete?: Complete;
  tools?: Tool<any>[];
  /** Records non-sensitive tool runs in the action log. */
  logRun?: (tool: string, args: unknown, result: unknown, ok: boolean) => Promise<void>;
}

const APPROVAL_PROMPT = "Reply *YES* to go ahead or *NO* to cancel.";
const CLAIMS_SENDING = /\b(sent|sending|(re)?send(ing)? (it|this|that|now)|i('| wi)ll (now )?(re)?(send|email|forward)|emailed|on its way|done)\b/i;

export async function runAgent(input: AgentInput, deps: AgentDeps): Promise<string> {
  const complete = deps.complete ?? sparkComplete;
  const toolList = deps.tools ?? allTools;
  const find = deps.tools ? (n: string) => toolList.find((t) => t.name === n) : getTool;
  const modelTools = toModelTools(toolList);

  const messages: ChatMessage[] = [
    { role: "system", content: input.system },
    ...input.history,
    { role: "user", content: input.content },
  ];

  // Text that tools require the user to see (a document explanation), in order.
  const shown: string[] = [];

  for (let step = 1; step <= MAX_STEPS; step++) {
    let msg = await complete(messages, modelTools);
    // The model occasionally returns nothing at all. One more try almost always answers.
    if (!msg.content?.trim() && !msg.tool_calls?.length) msg = await complete(messages, modelTools);

    const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
    if (!calls.length) {
      const reply = [...shown, cleanReply(msg.content ?? "")].filter(Boolean).join("\n\n");
      return reply || "Sorry, I lost track of that one. Could you send it again?";
    }

    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    let approvalSummary: string | null = null;

    for (const call of calls) {
      const result = await runCall(call.function.name, call.function.arguments, input.ctx, deps, find, approvalSummary !== null);
      if (result.approvalSummary) approvalSummary = result.approvalSummary;
      if (result.showUser) shown.push(result.showUser);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result.forModel) });
    }

    // A sensitive action is now waiting. Stop here and ask in fixed wording. The model's own
    // text is kept only when nothing else explains the request and it does not claim
    // that anything was or is being sent.
    if (approvalSummary) {
      const lead = cleanReply(msg.content ?? "");
      const intro = shown.length ? shown : [CLAIMS_SENDING.test(lead) ? "" : lead];
      return [...intro, approvalSummary, APPROVAL_PROMPT].filter(Boolean).join("\n\n");
    }
  }

  logger.warn({ steps: MAX_STEPS }, "agent hit step limit");
  return "That took more steps than I can handle in one go. Could you break it into smaller requests?";
}

async function runCall(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
  deps: AgentDeps,
  find: (n: string) => Tool<any> | undefined,
  alreadyGated: boolean,
): Promise<{ forModel: unknown; approvalSummary?: string; showUser?: string }> {
  const tool = find(name);
  if (!tool) return { forModel: { error: `Unknown tool ${name}.` } };

  let parsedJson: unknown;
  try {
    parsedJson = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { forModel: { error: "Arguments were not valid JSON." } };
  }
  const parsed = tool.schema.safeParse(parsedJson);
  if (!parsed.success) {
    return { forModel: { error: "Invalid arguments.", issues: parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join(".")}: ${i.message}`) } };
  }
  const args = parsed.data;

  if (tool.sensitive) {
    if (alreadyGated) return { forModel: { error: "Only one action can wait for approval at a time. Ask about this one after the user answers." } };
    let summary: string;
    try {
      summary = (await tool.summarize?.(args, ctx)) ?? `${tool.name}: ${JSON.stringify(args)}`;
    } catch (err) {
      return { forModel: { error: (err as Error).message } };
    }
    const req = await deps.gate.request(ctx.user.id, tool.name, args, summary);
    if (!req.ok) return { forModel: { error: req.reason } };
    return { forModel: { status: "waiting_for_user_approval", note: "Not done yet. The user must reply YES." }, approvalSummary: summary };
  }

  try {
    const result = await tool.run(args, ctx);
    await deps.logRun?.(tool.name, args, result.data ?? result.message, true);
    return { forModel: { ok: true, message: result.message, data: result.data }, showUser: result.showUser };
  } catch (err) {
    await deps.logRun?.(tool.name, args, (err as Error).message, false);
    logger.error({ err, tool: tool.name }, "tool failed");
    return { forModel: { error: `The ${tool.name} tool failed. Tell the user briefly and do not retry more than once.` } };
  }
}
